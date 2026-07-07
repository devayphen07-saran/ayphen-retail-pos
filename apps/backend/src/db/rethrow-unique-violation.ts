import postgres from 'postgres';

/**
 * drizzle-orm (0.44+) wraps every driver error in `DrizzleQueryError`, with
 * the real `postgres.PostgresError` preserved on `.cause` — a plain
 * `err instanceof postgres.PostgresError` check never matches anymore. Unwrap
 * once here so every PG-error call site pattern-matches on the real error
 * regardless of which layer (raw client vs. drizzle query builder) surfaced it.
 */
export function unwrapPgError(err: unknown): postgres.PostgresError | undefined {
  if (err instanceof postgres.PostgresError) return err;
  const cause = (err as { cause?: unknown } | null)?.cause;
  return cause instanceof postgres.PostgresError ? cause : undefined;
}

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
    const pgErr = unwrapPgError(err);
    if (
      pgErr &&
      pgErr.code === '23505' &&
      (constraintName === undefined || pgErr.constraint_name === constraintName)
    ) {
      throw toException();
    }
    throw err;
  }
}
