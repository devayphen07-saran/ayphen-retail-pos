import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import type { Redis } from 'ioredis';
import { AppConfigService } from '#config/app-config.service.js';
import { FilesService } from './files.service.js';
import { errorMessage } from '#common/error-message.js';
import { REDIS } from '#common/redis/redis.provider.js';

/** Redis lock so only one instance runs the temp-file sweep per tick — an
 *  in-process boolean does nothing across pods (mirrors
 *  DeviceSlotExpiryCronService's SET NX EX lock). TTL is generously above the
 *  cron cadence so a long-running sweep keeps the lock until it finishes
 *  rather than letting a second instance in mid-run. */
const SWEEP_LOCK = 'cron:temp-file-sweep';
const LOCK_TTL_SECONDS = 900;

export interface TempFileSweepStats {
  lastRunAt:        Date | null;
  lastDurationMs:   number;
  lastRemovedCount: number;
  error:            string | null;
}

/**
 * Reaps staged uploads that were never committed (Part C §C4 — the orphan
 * cleanup the old Java app never had). `temporary_files` is ephemeral: a row
 * past its `expires_at` means the user abandoned the form or the app crashed
 * mid-flow, so both the DB row and its object are safe to delete.
 */
@Injectable()
export class TempFileSweeperService implements OnModuleInit {
  private readonly logger = new Logger(TempFileSweeperService.name);
  readonly stats: TempFileSweepStats = {
    lastRunAt: null,
    lastDurationMs: 0,
    lastRemovedCount: 0,
    error: null,
  };

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly config: AppConfigService,
    private readonly files: FilesService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    const job = new CronJob(this.config.cronTempFileSweep, async () => {
      await this.sweep();
    });
    this.schedulerRegistry.addCronJob('temp-file-sweep', job);
    job.start();
    this.logger.log(`Temp-file sweeper cron registered: ${this.config.cronTempFileSweep}`);
  }

  /** Drain expired temps in bounded batches until none remain (or a batch is short). */
  async sweep(): Promise<void> {
    const lock = await this.redis.set(SWEEP_LOCK, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
    if (!lock) return;
    const start = Date.now();
    try {
      let total = 0;
      // Cap the passes so a huge backlog can't monopolise the tick; the next
      // run picks up the remainder.
      for (let pass = 0; pass < 20; pass++) {
        const removed = await this.files.sweepExpiredTemps(500);
        total += removed;
        if (removed < 500) break;
      }
      this.stats.lastRemovedCount = total;
      this.stats.error = null;
    } catch (err) {
      this.stats.error = errorMessage(err);
      this.logger.error(`Temp-file sweep failed: ${this.stats.error}`);
    } finally {
      this.stats.lastRunAt = new Date();
      this.stats.lastDurationMs = Date.now() - start;
      await this.redis.del(SWEEP_LOCK).catch(() => undefined);
    }
  }
}
