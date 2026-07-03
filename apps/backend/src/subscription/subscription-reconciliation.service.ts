import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import type { Redis } from 'ioredis';
import { env } from '#config/env.js';
import { MOBILE_REDIS } from '#auth/mobile/services/redis.provider.js';
import { AuditService } from '#auth/core/audit.service.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { SubscriptionService } from './subscription.service.js';

/** Redis lock so only one instance runs a given cron tick (device-mgmt §15 pattern). */
const RECON_LOCK = 'cron:subscription-reconcile';
const DRAIN_LOCK = 'cron:subscription-outbox-drain';
const LOCK_TTL_SECONDS = 300;
const OUTBOX_BATCH = 100;

/**
 * Time-based subscription transitions have no event — a trial just ends when the
 * clock reaches `trial_ends_at`. This cron (every 5 min, subscription §19) fills
 * that gap. Each transition is a single atomic `UPDATE … WHERE <predicate>` in
 * the repo, so a duplicate/concurrent run is a no-op (idempotent). A Redis lock
 * further prevents two instances from doing redundant work + audit.
 *
 * A second job drains the subscription_audit_outbox into audit_logs.
 */
@Injectable()
export class SubscriptionReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(SubscriptionReconciliationService.name);

  constructor(
    private readonly repo: SubscriptionRepository,
    private readonly subscriptions: SubscriptionService,
    private readonly audit: AuditService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(MOBILE_REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    const recon = new CronJob(env.CRON_SUBSCRIPTION_RECONCILIATION, () => {
      void this.reconcile();
    });
    this.scheduler.addCronJob('subscription-reconcile', recon);
    recon.start();

    const drain = new CronJob(env.CRON_SUBSCRIPTION_RECONCILIATION, () => {
      void this.drainOutbox();
    });
    this.scheduler.addCronJob('subscription-outbox-drain', drain);
    drain.start();

    this.logger.log(`Subscription reconcile + outbox drain registered: ${env.CRON_SUBSCRIPTION_RECONCILIATION}`);
  }

  /** Run all time-based transitions once, under a distributed lock. */
  async reconcile(): Promise<void> {
    const lock = await this.redis.set(RECON_LOCK, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
    if (!lock) return;
    const now = new Date();
    try {
      const trialed = await this.repo.expireTrials(now);

      // Version bumped in the UPDATE; invalidate caches so devices see it fast.
      await Promise.all(trialed.map((id) => this.subscriptions.invalidateCache(id)));

      // Outbox rows for the transition (best-effort; not in the set-based txn).
      await Promise.all(
        trialed.map((id) => this.repo.enqueueOutbox(id, 'SUBSCRIPTION_TRIAL_ENDED', {})),
      );

      if (trialed.length) {
        this.logger.log(`Reconcile: trial_ended=${trialed.length}`);
      }
    } catch (err) {
      this.logger.error('Subscription reconcile failed', err);
    } finally {
      await this.redis.del(RECON_LOCK).catch(() => undefined);
    }
  }

  /** Move pending outbox rows into audit_logs and stamp processed_at. */
  async drainOutbox(): Promise<void> {
    const lock = await this.redis.set(DRAIN_LOCK, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
    if (!lock) return;
    try {
      const pending = await this.repo.findPendingOutbox(OUTBOX_BATCH);
      for (const row of pending) {
        try {
          const payload = (row.payload ?? {}) as Record<string, unknown>;
          // Billing events are account-level; use the recorded actor, else the
          // account owner, so audit_logs.user_id (uuid, NOT NULL) is satisfied.
          const actorUserId =
            (typeof payload.actorUserId === 'string' && payload.actorUserId) ||
            (await this.repo.findAccountOwnerUserId(row.accountFk));
          if (!actorUserId) {
            // No owner resolvable (e.g. account mid-deletion) — mark processed to
            // avoid an unprocessable row wedging the queue.
            await this.repo.markOutboxProcessed(row.id, new Date());
            continue;
          }
          await this.audit.log({
            event:        row.eventType,
            activityType: 'SUBSCRIPTION_CHANGED',
            prefix:       'Subscription',
            suffix:       row.eventType.toLowerCase().replace(/_/g, ' '),
            userId:       actorUserId,
            isSuccess:    true,
            entityType:   'Subscription',
            metadata:     { accountId: row.accountFk, ...payload },
          });
          await this.repo.markOutboxProcessed(row.id, new Date());
        } catch (err) {
          // Leave the row pending; it retries next tick.
          this.logger.warn(`Outbox drain failed for ${row.id}: ${(err as Error).message}`);
        }
      }
      if (pending.length) this.logger.log(`Outbox drained: ${pending.length} rows`);
    } catch (err) {
      this.logger.error('Outbox drain failed', err);
    } finally {
      await this.redis.del(DRAIN_LOCK).catch(() => undefined);
    }
  }
}
