import Redis from 'ioredis';

let redis: Redis;

/** Lazy singleton bound to process.env.REDIS_URL — set by test/setup/env.ts before any import resolves this. */
export function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL!);
  return redis;
}

export async function closeRedis() {
  await redis?.quit();
}
