import { startContainers } from './containers';
import { runMigrations } from './migrate';
import { writeEnvHandoff } from './env-handoff';

/** Jest globalSetup — runs ONCE, in its own process, before all test suites. */
export default async function globalSetup() {
  const { databaseUrl, redisUrl, pgContainerId, redisContainerId } = await startContainers();

  await runMigrations(databaseUrl); // schema built once for the whole run

  // Test workers are separate processes — they read these back via
  // test/setup/env.ts (a `setupFiles` entry) before anything else loads.
  writeEnvHandoff({
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    pgContainerId,
    redisContainerId,
  });
}
