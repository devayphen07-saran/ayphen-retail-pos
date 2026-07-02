import { sql } from 'drizzle-orm';
import { getDb } from './db';
import { getRedis } from './redis';

/** Fast reset in milliseconds, not seconds — truncate, never re-migrate between tests. */
export async function resetDb() {
  const db = getDb();
  // Single statement, respects FKs via CASCADE, resets identity sequences
  await db.execute(sql`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN (
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT LIKE '__drizzle%'
      ) LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
      END LOOP;
    END $$;
  `);
}

export async function resetRedis() {
  await getRedis().flushdb();
}

export async function resetAll() {
  await Promise.all([resetDb(), resetRedis()]);
}
