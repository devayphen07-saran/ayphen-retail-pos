import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AppConfigService } from '#config/app-config.service.js';
import { FilesService } from './files.service.js';
import { errorMessage } from '#common/error-message.js';

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
  private isRunning = false;
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
    if (this.isRunning) return;
    this.isRunning = true;
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
      this.isRunning = false;
    }
  }
}
