/**
 * Extract a human-readable message from an `unknown` thrown value without an
 * unsafe `as Error` cast — a non-Error throw (string, driver object) stringifies
 * cleanly instead of yielding `undefined`.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}