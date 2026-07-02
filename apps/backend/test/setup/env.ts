import { readEnvHandoff } from './env-handoff';

/**
 * Registered via Jest `setupFiles` (NOT setupFilesAfterEnv) — runs before the
 * test framework installs and before any test file's module graph loads.
 * src/config/env.ts validates process.env at import time and calls
 * process.exit(1) if required vars are missing, so these must be set before
 * anything transitively imports it (db.ts, app.ts, and every service under
 * test all pull it in).
 */
const handoff = readEnvHandoff();

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = handoff.DATABASE_URL;
process.env.REDIS_URL = handoff.REDIS_URL;
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-characters-long';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-32-characters-long';
