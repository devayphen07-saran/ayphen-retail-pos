import type { Config } from 'drizzle-kit';

/** Generates SQL migrations + the expo-sqlite migrations snapshot from
 *  src/core/sync/db/schema.ts. Run via `pnpm --filter @ayphen/mobile db:generate`. */
export default {
  schema: './src/core/sync/db/schema.ts',
  out: './src/core/sync/db/migrations',
  dialect: 'sqlite',
  driver: 'expo',
} satisfies Config;
