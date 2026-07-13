import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import type { Redis } from 'ioredis';
import { AppConfigService } from '#config/app-config.service.js';
import { errorMessage } from '#common/error-message.js';
import { REDIS } from '#common/redis/redis.provider.js';
import { EntityTypesRepository } from '../entity-types/entity-types.repository.js';
import { FilesRepository } from './files.repository.js';
import { RecordExistenceService } from './record-existence.service.js';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from './storage/storage.provider.js';

/** Redis lock so only one instance runs the orphan-files reap per tick — an
 *  in-process boolean does nothing across pods (mirrors
 *  DeviceSlotExpiryCronService's SET NX EX lock). TTL is generously above the
 *  cron cadence so a long-running reap keeps the lock until it finishes
 *  rather than letting a second instance in mid-run. */
const REAP_LOCK = 'cron:orphan-files-reap';
const LOCK_TTL_SECONDS = 900;

export interface OrphanReapStats {
  lastRunAt: Date | null;
  lastDurationMs: number;
  lastReapedCount: number;
  error: string | null;
}

/**
 * Orphan-`files` reaper (image-offline-architecture.md P1-12b). `files.record_guuid`
 * has no FK, so a committed file whose parent record was later deleted becomes a
 * phantom — invisible to every store-scoped read join, consuming storage forever.
 * With the commit parent-check (P1-12a) in place this audit should find nothing
 * on the happy path; running it is how the invariant is *proven* rather than
 * assumed, and it catches post-commit parent deletions the app didn't cascade.
 *
 * Only audits entities with a registered record resolver (fail-safe — never reap
 * a file whose parent we can't verify).
 */
@Injectable()
export class OrphanFilesReaperService implements OnModuleInit {
  private readonly logger = new Logger(OrphanFilesReaperService.name);
  readonly stats: OrphanReapStats = {
    lastRunAt: null,
    lastDurationMs: 0,
    lastReapedCount: 0,
    error: null,
  };

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly config: AppConfigService,
    private readonly entityTypes: EntityTypesRepository,
    private readonly filesRepo: FilesRepository,
    private readonly recordExistence: RecordExistenceService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    const job = new CronJob(this.config.cronOrphanFilesReap, async () => {
      await this.reap();
    });
    this.schedulerRegistry.addCronJob('orphan-files-reap', job);
    job.start();
    this.logger.log(
      `Orphan-files reaper cron registered: ${this.config.cronOrphanFilesReap}`,
    );
  }

  /** Soft-delete committed files whose parent no longer resolves, plus their objects. */
  async reap(): Promise<number> {
    const lock = await this.redis.set(
      REAP_LOCK,
      '1',
      'EX',
      LOCK_TTL_SECONDS,
      'NX',
    );
    if (!lock) return 0;
    const start = Date.now();
    let total = 0;
    try {
      for (const code of this.recordExistence.registeredCodes()) {
        const entity = await this.entityTypes.findByCode(code);
        if (!entity) continue;
        // Bounded passes per entity so one huge backlog can't monopolise the tick.
        for (let pass = 0; pass < 20; pass++) {
          const orphans = await this.recordExistence.findOrphanedFiles(
            code,
            entity.id,
            500,
          );
          if (orphans.length === 0) break;
          for (const orphan of orphans) {
            await this.safeDelete(orphan.storageKey);
            await this.filesRepo.reapOrphan(orphan.guuid);
            total += 1;
          }
          if (orphans.length < 500) break;
        }
      }
      this.stats.lastReapedCount = total;
      this.stats.error = null;
      if (total > 0)
        this.logger.warn(
          `Reaped ${total} orphaned file(s) with no live parent.`,
        );
      return total;
    } catch (err) {
      this.stats.error = errorMessage(err);
      this.logger.error(`Orphan-files reap failed: ${this.stats.error}`);
      return total;
    } finally {
      this.stats.lastRunAt = new Date();
      this.stats.lastDurationMs = Date.now() - start;
      await this.redis.del(REAP_LOCK).catch(() => undefined);
    }
  }

  private async safeDelete(key: string): Promise<void> {
    try {
      await this.storage.deleteObject(key);
    } catch (err) {
      this.logger.warn(
        `Best-effort object delete failed for ${key}: ${errorMessage(err)}`,
      );
    }
  }
}
