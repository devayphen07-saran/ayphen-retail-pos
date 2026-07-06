/**
 * Assert a single-row DB result is present.
 *
 * An insert's `.returning()` yields exactly one row on success, so the value is
 * safe *by contract* — but a bare `return row!` hides that contract from the
 * type-checker: a later refactor to `.onConflictDoNothing()` (which can return
 * zero rows) would silently make the `!` unsound. `requireRow` keeps the value
 * non-null while making a violated contract fail loudly with context instead.
 */
export function requireRow<T>(row: T | undefined | null, context = 'insert'): T {
  if (row == null) {
    throw new Error(`Expected a row from ${context} but received none`);
  }
  return row;
}
