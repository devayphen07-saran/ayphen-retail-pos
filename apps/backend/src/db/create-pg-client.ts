import postgres, { type Sql } from 'postgres';

export interface CreatePgClientOptions {
  /** Pool size. Long-lived app handle passes an env-sized max;
   *  one-off scripts (seed/flush) pass max: 1 — no pool to leak. */
  max?: number;
  /** Per-query cap in ms. Pass 0 to DISABLE — seed/flush run migrations/DDL
   *  that legitimately exceed any app-level statement timeout. */
  statementTimeoutMs?: number;
}

/**
 * Single source of truth for the postgres-js client config (TLS, timeouts,
 * pool size) — the app handle (db.module.ts) and one-off scripts (seed.ts,
 * flush.ts) all go through this so they can't drift. Without this, the app
 * handle previously ran with zero options: no TLS against a managed Postgres
 * instance either fails outright or silently connects unencrypted.
 */
export function createPgClient(url: string, opts: CreatePgClientOptions = {}): Sql {
  const statementTimeoutMs = opts.statementTimeoutMs ?? 10_000;
  return postgres(url, {
    max:             opts.max,
    // Disable named prepared statements: this connects through Supabase's
    // Supavisor pooler (…pooler.supabase.com), which multiplexes/recycles server
    // connections. A prepared statement created on one backend may not exist on
    // the next, surfacing as intermittent "Failed query" errors (the SQL itself
    // is valid — it succeeds in isolation). postgres-js's simple protocol is
    // pooler-safe. No code relies on drizzle `.prepare()`, so this is a pure
    // robustness win. (Supabase's documented recommendation for poolers.)
    prepare:         false,
    // 'verify-full' authenticates the server certificate (CA + hostname) rather
    // than 'require', which encrypts but does not verify — closes a MITM window.
    ssl:             process.env.NODE_ENV === 'production' ? 'verify-full' : undefined,
    idle_timeout:    20,
    connect_timeout: 10,
    connection: {
      // Without a statement timeout, one slow query pins its pooled connection
      // until the DB kills it; enough of them exhaust the pool and hang the
      // whole service. The 30s HTTP timeout 408s the client but never cancels
      // the query. 0 disables (scripts).
      statement_timeout:                   statementTimeoutMs,
      idle_in_transaction_session_timeout: statementTimeoutMs ? statementTimeoutMs + 5_000 : 0,
    },
  });
}
