/**
 * db:flush — drops every table in the public schema, then re-runs all
 * Drizzle migrations from scratch. Safe for local dev only.
 *
 * Usage:  pnpm db:flush
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPgClient } from '../create-pg-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[flush] DATABASE_URL is not set');
  process.exit(1);
}

// Gate on the connection TARGET, not NODE_ENV — which env.ts defaults to
// 'development' and is trivially unset, so the old guard was inert. A non-local
// database must be explicitly confirmed by name; localhost dev flushes freely
// (keeps `pnpm db:reset` working).
const target = new URL(url);
const dbName = target.pathname.replace(/^\//, '');
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(target.hostname);
if (!isLocal && process.env.CONFIRM_FLUSH !== dbName) {
  console.error(
    `[flush] Refusing to flush non-local database "${dbName}" on ${target.hostname}. ` +
      `Re-run with CONFIRM_FLUSH=${dbName} to proceed.`,
  );
  process.exit(1);
}

// __dirname = apps/backend/src/db/scripts → up 3 = apps/backend, then /drizzle
// (matches drizzle.config.ts `out: './drizzle'`).
const migrationsFolder = path.resolve(__dirname, '../../../drizzle');

// Verify migrations exist BEFORE dropping anything. Otherwise a bad path would
// drop every table and then fail to re-migrate, leaving the DB empty and broken.
if (!fs.existsSync(path.join(migrationsFolder, 'meta', '_journal.json'))) {
  console.error(
    `[flush] Migrations not found at ${migrationsFolder}. ` +
      'Refusing to drop tables — run `pnpm db:generate` first.',
  );
  process.exit(1);
}

const sql = createPgClient(url, { max: 1, statementTimeoutMs: 0 });
const db  = drizzle(sql);

async function flush() {
  console.log('[flush] Dropping all tables in public schema...');

  // Drop everything in dependency order — cascade handles FKs
  await sql`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
      LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END$$;
  `;

  // Also drop the drizzle migrations tracking table so migrate runs clean
  await sql`DROP TABLE IF EXISTS drizzle.__drizzle_migrations CASCADE`;
  await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;

  console.log('[flush] All tables dropped.');

  console.log('[flush] Running migrations...');
  await migrate(db, { migrationsFolder });
  console.log('[flush] Migrations complete.');

  await sql.end();
}

flush().catch((err) => {
  console.error('[flush] Failed:', err);
  process.exit(1);
});
