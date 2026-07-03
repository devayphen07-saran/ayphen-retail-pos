import postgres, { type Sql } from 'postgres';

export interface CreatePgClientOptions {
  /** Pool size. Long-lived app handle uses postgres-js's default pool;
   *  one-off scripts (seed/flush) pass max: 1 — no pool to leak. */
  max?: number;
}

/**
 * Single source of truth for the postgres-js client config (TLS, timeouts,
 * pool size) — the app handle (db.module.ts) and one-off scripts (seed.ts,
 * flush.ts) all go through this so they can't drift. Without this, the app
 * handle previously ran with zero options: no TLS against a managed Postgres
 * instance either fails outright or silently connects unencrypted.
 */
export function createPgClient(url: string, opts: CreatePgClientOptions = {}): Sql {
  return postgres(url, {
    max:             opts.max,
    ssl:             process.env.NODE_ENV === 'production' ? 'require' : undefined,
    idle_timeout:    20,
    connect_timeout: 10,
  });
}
