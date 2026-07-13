import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { lt } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { revokedTokens } from '#db/schema.js';
import { AppConfigService } from '#config/app-config.service.js';
import { errorMessage } from '#common/error-message.js';
import { REDIS } from '#common/redis/redis.provider.js';

export interface TokenCleanupStats {
  lastRunAt:      Date | null;
  lastDurationMs: number;
  lastRemovedCount: number;
  error:          string | null;
}

/** Redis lock so only one instance runs the sweep per tick (mirrors
 *  DeviceSlotExpiryCronService §11.2/§11.3) — an in-process boolean alone
 *  does nothing across multiple pods, each with its own memory. The
 *  underlying DELETE is idempotent either way, so this is a belt-and-
 *  suspenders correctness fix (avoids redundant concurrent sweeps) rather
 *  than one guarding against corruption. TTL is generously above the cron
 *  cadence so a long-running sweep keeps the lock until it finishes rather
 *  than letting a second instance in mid-run. */
const CLEANUP_LOCK = 'cron:token-cleanup';
const LOCK_TTL_SECONDS = 900;

@Injectable()
export class TokenCleanupService implements OnModuleInit {
  private readonly logger = new Logger(TokenCleanupService.name);
  readonly stats: TokenCleanupStats = {
    lastRunAt:        null,
    lastDurationMs:   0,
    lastRemovedCount: 0,
    error:            null,
  };

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly schedulerRegistry:   SchedulerRegistry,
    private readonly config:              AppConfigService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    const job = new CronJob(this.config.cronTokenCleanup, async () => {
      await this.cleanExpiredTokens();
    });
    this.schedulerRegistry.addCronJob('token-cleanup', job);
    job.start();
    this.logger.log(`Token cleanup cron registered: ${this.config.cronTokenCleanup}`);
  }

  async cleanExpiredTokens(): Promise<void> {
    const lock = await this.redis.set(CLEANUP_LOCK, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
    if (!lock) return;
    const start = Date.now();
    try {
      // `returning` yields the deleted ids, so `.length` is an accurately typed
      // count — no fragile cast through the driver's result shape.
      const deleted = await this.db
        .delete(revokedTokens)
        .where(lt(revokedTokens.expiresAt, new Date()))
        .returning({ jti: revokedTokens.jti });
      const count = deleted.length;
      this.stats.lastRunAt        = new Date();
      this.stats.lastDurationMs   = Date.now() - start;
      this.stats.lastRemovedCount = count;
      this.stats.error            = null;
      this.logger.log(`Token cleanup: removed ${count} expired revoked tokens`);
    } catch (err) {
      this.stats.error = errorMessage(err);
      this.logger.error('Token cleanup failed', err);
    } finally {
      await this.redis.del(CLEANUP_LOCK).catch(() => undefined);
    }
  }
}
