/**
 * db:flush — drops every table in the public schema, then re-runs all
 * Drizzle migrations from scratch. Safe for local dev only.
 *
 * Usage:  pnpm db:flush
 */
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[flush] DATABASE_URL is not set');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
  console.error('[flush] Refusing to flush a production database');
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

const sql = postgres(url, { max: 1 });
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
