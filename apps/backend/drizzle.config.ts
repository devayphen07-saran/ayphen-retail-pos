import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Every pending migration runs in ONE transaction (drizzle-orm/pg-core's
// migrator) — `CREATE INDEX CONCURRENTLY` cannot appear in any migration file
// generated from this config. See drizzle/CONCURRENT_INDEXES.md for the
// manual workaround procedure if a future large-table index needs one.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
