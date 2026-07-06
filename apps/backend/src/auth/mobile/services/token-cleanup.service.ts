import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { lt } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { revokedTokens } from '#db/schema.js';
import { env } from '#config/env.js';
import { errorMessage } from '#common/error-message.js';

export interface TokenCleanupStats {
  lastRunAt:      Date | null;
  lastDurationMs: number;
  lastRemovedCount: number;
  error:          string | null;
}

@Injectable()
export class TokenCleanupService implements OnModuleInit {
  private readonly logger = new Logger(TokenCleanupService.name);
  private isRunning = false;
  readonly stats: TokenCleanupStats = {
    lastRunAt:        null,
    lastDurationMs:   0,
    lastRemovedCount: 0,
    error:            null,
  };

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly schedulerRegistry:   SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const job = new CronJob(env.CRON_TOKEN_CLEANUP, async () => {
      await this.cleanExpiredTokens();
    });
    this.schedulerRegistry.addCronJob('token-cleanup', job);
    job.start();
    this.logger.log(`Token cleanup cron registered: ${env.CRON_TOKEN_CLEANUP}`);
  }

  async cleanExpiredTokens(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
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
      this.isRunning = false;
    }
  }
}
