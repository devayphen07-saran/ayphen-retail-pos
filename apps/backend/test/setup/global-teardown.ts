import { stopContainersById } from './containers';
import { readEnvHandoff, clearEnvHandoff } from './env-handoff';

/** Jest globalTeardown — runs ONCE, in a fresh process, after all test suites. */
export default async function globalTeardown() {
  const { pgContainerId, redisContainerId } = readEnvHandoff();
  await stopContainersById({ pgContainerId, redisContainerId });
  clearEnvHandoff();
}
