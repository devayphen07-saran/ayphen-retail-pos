import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema';

let client: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;

/** Lazy singleton bound to process.env.DATABASE_URL — set by test/setup/env.ts before any import resolves this. */
export function getDb() {
  if (!db) {
    client = postgres(process.env.DATABASE_URL!, {
      max: 5,
      // Silence CASCADE-truncate NOTICEs — expected noise from resetDb(), not signal.
      onnotice: () => {},
    });
    db = drizzle(client, { schema });
  }
  return db;
}

export async function closeDb() {
  await client?.end();
}
