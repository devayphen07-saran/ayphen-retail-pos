import type { FieldErrors, FieldValues } from 'react-hook-form';
import { logger } from './logger';

/**
 * The second argument to `handleSubmit(onValid, onInvalid)`. Runs when
 * client-side (Zod) validation blocks a submit. Without it, tapping the submit
 * button on an invalid form appears to "do nothing" (forms-agent.md §6/§7/§13).
 *
 * On these short auth screens every field is already on-screen, so there is
 * nothing to scroll to — the visible per-field errors (RHF sets them here) are
 * the feedback. This handler's job is to guarantee the failure is never silent:
 * it logs which fields blocked the submit. Extend with scroll/focus-first-error
 * when a longer form needs it.
 */
export function onValidationError<T extends FieldValues>(
  errors: FieldErrors<T>,
): void {
  const fields = Object.keys(errors);
  if (fields.length === 0) return;
  logger.warn('[form] submit blocked by validation', { fields });
}
