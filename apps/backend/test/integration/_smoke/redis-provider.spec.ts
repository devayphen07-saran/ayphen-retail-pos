import Redis from 'ioredis';
import { env } from '../../../src/config/env';

describe('Redis provider construction in isolation', () => {
  it('env.REDIS_URL is set', () => {
    console.log('REDIS_URL:', env.REDIS_URL);
    expect(env.REDIS_URL).toBeDefined();
  });

  it('new Redis(...) does not throw and returns a defined instance', () => {
    const redis = new Redis(env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
    });
    console.log('typeof redis:', typeof redis);
    console.log('redis defined:', redis !== undefined);
    expect(redis).toBeDefined();
    redis.disconnect();
  });
});