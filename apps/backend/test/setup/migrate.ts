import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import path from 'path';

/** apps/backend/drizzle — see drizzle.config.ts `out`, NOT src/db/migrations. */
const MIGRATIONS_FOLDER = path.join(__dirname, '../../drizzle');

export async function runMigrations(uri: string) {
  const sql = postgres(uri, { max: 1 });
  await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
  await sql.end();
}
