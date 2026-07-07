import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { lt } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { loginAttempts } from '#db/schema.js';
import { AppConfigService } from '#config/app-config.service.js';
import { errorMessage } from '#common/error-message.js';

export interface LoginAttemptsCleanupStats {
  lastRunAt:        Date | null;
  lastDurationMs:   number;
  lastRemovedCount: number;
  error:            string | null;
}

/**
 * loginAttempts is append-only on every auth attempt and, since the limiter
 * enforcement moved to Redis counters, is read only as a fallback/audit
 * trail — without retention it grows without bound (flow-critic Phase 2).
 * Rows older than LOGIN_ATTEMPTS_RETENTION_DAYS carry no enforcement or
 * audit value (auditLogs holds the durable security record).
 */
@Injectable()
export class LoginAttemptsCleanupService implements OnModuleInit {
  private readonly logger = new Logger(LoginAttemptsCleanupService.name);
  private isRunning = false;
  readonly stats: LoginAttemptsCleanupStats = {
    lastRunAt:        null,
    lastDurationMs:   0,
    lastRemovedCount: 0,
    error:            null,
  };

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly schedulerRegistry:   SchedulerRegistry,
    private readonly config:              AppConfigService,
  ) {}

  onModuleInit(): void {
    const job = new CronJob(this.config.cronLoginAttemptsCleanup, async () => {
      await this.cleanOldAttempts();
    });
    this.schedulerRegistry.addCronJob('login-attempts-cleanup', job);
    job.start();
    this.logger.log(`Login-attempts cleanup cron registered: ${this.config.cronLoginAttemptsCleanup}`);
  }

  async cleanOldAttempts(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    const start = Date.now();
    try {
      const cutoff = new Date(Date.now() - this.config.loginAttemptsRetentionDays * 24 * 60 * 60 * 1000);
      const deleted = await this.db
        .delete(loginAttempts)
        .where(lt(loginAttempts.createdAt, cutoff))
        .returning({ id: loginAttempts.id });
      const count = deleted.length;
      this.stats.lastRunAt        = new Date();
      this.stats.lastDurationMs   = Date.now() - start;
      this.stats.lastRemovedCount = count;
      this.stats.error            = null;
      this.logger.log(`Login-attempts cleanup: removed ${count} rows older than ${this.config.loginAttemptsRetentionDays}d`);
    } catch (err) {
      this.stats.error = errorMessage(err);
      this.logger.error('Login-attempts cleanup failed', err);
    } finally {
      this.isRunning = false;
    }
  }
}
