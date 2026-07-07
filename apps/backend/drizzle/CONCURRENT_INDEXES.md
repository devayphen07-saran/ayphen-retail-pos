# `CREATE INDEX CONCURRENTLY` — not supported by `pnpm db:migrate`

**The constraint:** `drizzle-kit migrate` (and `drizzle-orm`'s underlying
`postgres-js`/`node-postgres` migrator) wraps every pending migration file —
all statements, all files, in one run — in a single `BEGIN ... COMMIT` block
(`PgDialect.migrate()` in `drizzle-orm/pg-core/dialect.js`). There is no
config flag to disable this in the installed version. Postgres rejects
`CREATE INDEX CONCURRENTLY` inside a transaction block outright (error
`25001`), so a migration file containing it will fail the entire batch —
this isn't a lock-duration tradeoff, it's a hard failure.

**When this matters:** adding an index to a table large/hot enough that a
regular `CREATE INDEX` (which takes an `ACCESS EXCLUSIVE`-blocking `SHARE`
lock for its duration) would stall production writes for an unacceptable
window. None of the current schema's tables are at that scale yet — this is
a documented gap for when one is.

**Workaround procedure, when it's actually needed:**

1. Do **not** put the `CREATE INDEX CONCURRENTLY ...` statement in a normal
   `drizzle-kit generate` migration file — it will fail as above.
2. Run it by hand against the target database, outside any transaction:
   ```sh
   psql "$DATABASE_URL" -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_foo ON bar (baz);'
   ```
   `psql` runs each `-c` statement in its own implicit transaction (none, for
   DDL like this), which is what `CONCURRENTLY` requires. Never wrap this in
   `BEGIN`/`COMMIT`.
3. Still generate the normal `drizzle-kit generate` migration for the schema
   change itself (so `schema.ts` and the migration journal stay the source of
   truth) — but make its SQL a no-op for the index specifically, e.g.
   `CREATE INDEX IF NOT EXISTS` guarded so it's a cheap no-op once step 2 has
   already created the real one. Comment the migration file explaining why,
   pointing back to this doc.
4. Run step 2 first, in production, before deploying the release that ships
   the migration from step 3 — so `drizzle-kit migrate`'s normal transactional
   run just finds the index already present.

This is a manual runbook step, not automation — there's no way to make
`pnpm db:migrate` do this safely with the current tooling.