import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MS_PER_DAY } from '#common/time.js';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import type { Redis } from 'ioredis';
import { AppConfigService } from '#config/app-config.service.js';
import { errorMessage } from '#common/error-message.js';
import { REDIS } from '#common/redis/redis.provider.js';
import { UnitOfWork, type DbTransaction } from '#db/db.module.js';
import { DeviceAccessRepository } from './device-access.repository.js';

/** Redis lock so only one instance runs the expiry sweep per tick (§11.2/§11.3).
 *  TTL is generously above the cron cadence so a long-running sweep keeps the
 *  lock until it finishes rather than letting a second instance in mid-run. */
const EXPIRY_LOCK = 'cron:device-expiry';
const LOCK_TTL_SECONDS = 900;

/**
 * A slot idle this long with no heartbeat auto-expires — storeDeviceAccess's
 * own doc comment already names this design ("slots free on owner-remove /
 * block / 30-day expiry"), it just had no implementation until now.
 * `touchSlot()` runs on every `claimSlot()` re-claim, so a device in regular
 * use never trips this — only a device that opened a store once and was then
 * abandoned (uninstalled, replaced, forgotten) without ever being logged out
 * or manually removed by the owner.
 */
const STALE_DAYS = 30;

/** Bounds each transaction to one batch — a mass idle-expiry must never run
 *  as one unbounded UPDATE (mirrors SubscriptionLifecycleCronService). */
const BATCH_SIZE = 500;

export interface DeviceSlotExpiryStats {
  lastRunAt:        Date | null;
  lastDurationMs:   number;
  lastExpiredCount: number;
  error:            string | null;
}

/**
 * Backstop for slots nothing else released: `AuthLogoutService.logout()`
 * releases a device's slots on an explicit logout, and an owner can remove a
 * device manually — but a device that's simply abandoned (no logout, no
 * removal) would otherwise hold its slot forever, silently consuming one of
 * the plan's limited `max_devices_per_store` seats. This cron reclaims those.
 */
@Injectable()
export class DeviceSlotExpiryCronService implements OnModuleInit {
  private readonly logger = new Logger(DeviceSlotExpiryCronService.name);
  readonly stats: DeviceSlotExpiryStats = {
    lastRunAt:        null,
    lastDurationMs:   0,
    lastExpiredCount: 0,
    error:            null,
  };

  constructor(
    private readonly repo:              DeviceAccessRepository,
    private readonly uow:               UnitOfWork,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly config:            AppConfigService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    const job = new CronJob(this.config.cronDeviceAutoExpiry, async () => {
      await this.expireStaleSlots();
    });
    this.schedulerRegistry.addCronJob('device-slot-auto-expiry', job);
    job.start();
    this.logger.log(`Device slot auto-expiry cron registered: ${this.config.cronDeviceAutoExpiry}`);
  }

  /** Distributed lock (§11.2/§11.3): device-expiry mutates shared state
   *  (`store_device_access`), so a `SET NX EX` claim ensures only one instance
   *  runs the sweep per tick — the previous in-memory boolean did nothing across
   *  pods. A redundant run would still be a no-op on already-expired rows, but
   *  the spec mandates the lock, mirroring SubscriptionLifecycleCronService. */
  async expireStaleSlots(): Promise<void> {
    const lock = await this.redis.set(EXPIRY_LOCK, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
    if (!lock) return;
    const start = Date.now();
    try {
      const staleBefore = new Date(Date.now() - STALE_DAYS * MS_PER_DAY);
      let expiredCount = 0;
      for (;;) {
        const batch = await this.uow.execute((tx: DbTransaction) =>
          this.repo.expireStaleSlots(staleBefore, BATCH_SIZE, tx),
        );
        expiredCount += batch.length;
        if (batch.length < BATCH_SIZE) break;
      }
      this.stats.lastRunAt        = new Date();
      this.stats.lastDurationMs   = Date.now() - start;
      this.stats.lastExpiredCount = expiredCount;
      this.stats.error            = null;
      if (expiredCount) {
        this.logger.log(`Device slot auto-expiry: expired ${expiredCount} slot(s) idle ${STALE_DAYS}+ days`);
      }
    } catch (err) {
      this.stats.error = errorMessage(err);
      this.logger.error('Device slot auto-expiry failed', err);
    } finally {
      await this.redis.del(EXPIRY_LOCK).catch(() => undefined);
    }
  }
}
