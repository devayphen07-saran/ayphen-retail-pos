import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Jest's globalSetup runs in its own process, isolated from every test
 * worker — mutating process.env there never reaches the workers that import
 * env.ts (which itself calls process.exit(1) on missing vars at import
 * time). This file is the handoff: globalSetup writes container connection
 * info here, and test/setup/env.ts (registered via `setupFiles`, which runs
 * before the test framework and before any app module is imported) reads it
 * back into process.env in every worker.
 */
const HANDOFF_PATH = path.join(os.tmpdir(), 'ayphen-backend-test-env.json');

export interface TestEnvHandoff {
  DATABASE_URL: string;
  REDIS_URL: string;
  /** Container IDs — globalTeardown runs in a fresh process and reconnects by ID to stop them. */
  pgContainerId: string;
  redisContainerId: string;
}

export function writeEnvHandoff(vars: TestEnvHandoff): void {
  fs.writeFileSync(HANDOFF_PATH, JSON.stringify(vars), 'utf-8');
}

export function readEnvHandoff(): TestEnvHandoff {
  const raw = fs.readFileSync(HANDOFF_PATH, 'utf-8');
  return JSON.parse(raw) as TestEnvHandoff;
}

export function clearEnvHandoff(): void {
  fs.rmSync(HANDOFF_PATH, { force: true });
}
