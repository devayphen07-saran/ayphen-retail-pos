import type { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { env } from '../../config/env.js';

/**
 * CORE_REDIS token + provider, in its own file to avoid a circular import:
 * services that inject CORE_REDIS must not import it from auth-core.module.ts
 * (which in turn imports those services) — that leaves the token undefined at
 * decoration time and breaks DI resolution.
 */
export const CORE_REDIS = Symbol('CORE_REDIS');

export const CoreRedisProvider: Provider = {
  provide: CORE_REDIS,
  useFactory: () =>
    new Redis(env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableReadyCheck:     true,
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
    }),
};
