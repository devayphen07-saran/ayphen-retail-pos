import type { UseFormSetError, FieldValues, Path } from 'react-hook-form';
import { Alert } from '@nks/mobile-ui-components';
import type { NormalizedError } from '@ayphen-retail/api-manager';

/**
 * Canonical form-error handler (form-pattern.md §7.2 / Appendix C), adapted to
 * this codebase's error shape (`NormalizedError` from api-manager) and the
 * native `Alert` surface (no toast system yet).
 *
 * Precedence: field errors → offline → 401 → 403 → 409 → message → fallback.
 * Never silent (Principle 3).
 */
export function handleFormError<T extends FieldValues>(
  err: unknown,
  setError: UseFormSetError<T>,
  fallbackMessage = 'Something went wrong. Please try again.',
): void {
  const error = err as Partial<NormalizedError> & {
    fieldErrors?: Record<string, string>;
    data?: { error?: { fieldErrors?: Record<string, string> } };
  };

  // 1. Field-specific server validation errors.
  const fieldErrors =
    error?.fieldErrors ?? error?.data?.error?.fieldErrors ?? undefined;
  if (fieldErrors && typeof fieldErrors === 'object') {
    for (const [field, message] of Object.entries(fieldErrors)) {
      setError(field as Path<T>, { type: 'server', message: String(message) });
    }
    return;
  }

  // 2. Network / offline.
  if (error?.isOffline || error?.code === 'network_error' || error?.code === 'timeout') {
    Alert.info(
      'No connection',
      'No internet connection. Check your network and try again.',
    );
    return;
  }

  // 3–5. Auth / permission / conflict.
  if (error?.status === 401) {
    Alert.info('Session expired', 'Please log in again.');
    return;
  }
  if (error?.status === 403) {
    Alert.info('Not allowed', error?.message ?? "You don't have permission to do this.");
    return;
  }
  if (error?.status === 409) {
    Alert.info('Conflict', error?.message ?? 'This was updated elsewhere. Try again.');
    return;
  }

  // 6–7. Message, then fallback.
  Alert.info('Error', error?.message ?? fallbackMessage);
  if (!error?.message) console.error('[handleFormError] Unknown error:', err);
}
