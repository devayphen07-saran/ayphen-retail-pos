import postgres from 'postgres';

/**
 * Run a write that can lose a uniqueness race to a concurrent request, and
 * normalize the resulting Postgres unique-violation into the same exception
 * the call site's pre-check already throws for the non-racing case — so the
 * client sees one consistent error regardless of timing, instead of an
 * uncaught 23505 falling through to the global filter's generic 409.
 *
 * Pass `constraintName` when the table can violate more than one unique
 * constraint and only a specific one should map to `toException` — otherwise
 * any 23505 on the statement is treated as the violation.
 */
export async function rethrowUniqueViolationAs<T>(
  op: Promise<T>,
  toException: () => Error,
  constraintName?: string,
): Promise<T> {
  try {
    return await op;
  } catch (err) {
    if (
      err instanceof postgres.PostgresError &&
      err.code === '23505' &&
      (constraintName === undefined || err.constraint_name === constraintName)
    ) {
      throw toException();
    }
    throw err;
  }
}
