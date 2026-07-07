import { Inject, Injectable, Logger, type OnApplicationShutdown, Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '#config/app-config.service.js';

export const REDIS = Symbol('REDIS');

const logger = new Logger('RedisClient');

export const RedisProvider: Provider = {
  provide: REDIS,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService) => {
    const redis = new Redis(config.redisUrl || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableReadyCheck:     true,
      // Per-command deadline: `maxRetriesPerRequest` only bounds a DOWN socket;
      // a connected-but-hung Redis (network stall, slow LUA) would otherwise
      // leave every `await redis.*` pending until the 30s HTTP timeout. 1.5s
      // rejects fast so the callers' try/catch can degrade to the DB. Safe
      // because no blocking commands (BLPOP/XREAD BLOCK) are used — the
      // rate-limiter's EVAL is fast.
      commandTimeout:       1500,
      connectTimeout:       10_000,
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
    });
    // ioredis emits 'error' on every failed connection attempt; Node's
    // EventEmitter crashes the process on an 'error' event with no listener.
    redis.on('error', (err) => logger.error(`Redis client error: ${err.message}`, err.stack));
    return redis;
  },
};

/** Mirrors DatabaseLifecycle (db/db.module.ts) — drains the Redis socket on
 *  SIGTERM so shutdown is symmetric with the Postgres pool's drain. */
@Injectable()
export class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
