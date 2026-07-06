import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { REDIS } from '#common/redis/redis.provider.js';
import { env } from '#config/env.js';
import { RedisThrottlerStorage } from './redis-throttler-storage.js';

/**
 * Global per-IP throttler (THROTTLE_GLOBAL_LIMIT req/min, default 300).
 * This is a DDoS backstop, not an abuse control: mobile traffic arrives via
 * carrier-grade NAT, so a single IP is thousands of legitimate users — real
 * abuse limits are identity-scoped (per-phone OTP limits, per-session
 * step-up counters). Storage is Redis-backed (via the shared REDIS
 * connection, provided by the @Global RedisModule) so the limit is
 * cluster-wide and survives restarts. Stricter per-route limits on sensitive
 * auth endpoints are applied with @Throttle() on those handlers.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [REDIS],
      useFactory: (redis: Redis) => ({
        throttlers: [
          {
            name:  'global',
            ttl:   60_000,
            limit: env.THROTTLE_GLOBAL_LIMIT,
          },
        ],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
  ],
})
export class ThrottleModule {}
