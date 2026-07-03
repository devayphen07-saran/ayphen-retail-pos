import type { UseFormSetError, FieldValues, Path } from 'react-hook-form';
import { Alert } from '@ayphen/mobile-ui-components';
import type { NormalizedError } from '@ayphen/api-manager';

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
    // A 401 is NOT always an expired session. Login/verify returns 401 for
    // "user not found", "invalid otp", etc. — surface the real server message
    // there. Only show the "session expired, log in again" copy for genuine
    // token/session-expiry codes (the ones the JWT guard + refresh throw).
    const code = (error?.code ?? '').toUpperCase();
    const SESSION_CODES = new Set([
      'TOKEN_EXPIRED',
      'SESSION_EXPIRED',
      'TOKEN_REVOKED',
      'SESSION_REVOKED',
      'SESSION_NOT_FOUND',
      'MISSING_TOKEN',
      'INVALID_TOKEN_TYPE',
    ]);
    if (SESSION_CODES.has(code)) {
      Alert.info('Session expired', 'Please log in again.');
    } else {
      // e.g. USER_NOT_FOUND, INVALID_OTP, USER_SUSPENDED — show the actual reason.
      Alert.info('Error', error?.message ?? 'Please try again.');
    }
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

  // 6–7. Message, then fallback. Shown as an Alert only — no inline error under
  // the fields (the Alert carries the backend message; a duplicate below the
  // inputs is noise).
  const message = error?.message ?? fallbackMessage;
  Alert.info('Error', message);
  if (!error?.message) console.error('[handleFormError] Unknown error:', err);
}
