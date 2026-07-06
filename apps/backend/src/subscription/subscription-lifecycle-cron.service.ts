import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import type { Redis } from 'ioredis';
import { env } from '#config/env.js';
import { errorMessage } from '#common/error-message.js';
import { REDIS } from '#common/redis/redis.provider.js';
import { AuditService } from '#common/audit/audit.service.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { SubscriptionService } from './subscription.service.js';
import { UnitOfWork, type DbTransaction } from '#db/db.module.js';

/** Redis lock so only one instance runs a given cron tick (device-mgmt §15 pattern). */
const RECON_LOCK = 'cron:subscription-reconcile';
const DRAIN_LOCK = 'cron:subscription-outbox-drain';
// Deliberately 3x the default 5-min cron cadence, NOT tied to it: if a tick
// ever runs long (DB hiccup, large batch), the lock must still outlive it —
// equal-to-cadence left zero margin, letting a slow run's TTL expire while it
// was still working, so a second instance could acquire the lock and both
// would then unconditionally DEL it in `finally` (flow-critic review §2).
const LOCK_TTL_SECONDS = 900;
const OUTBOX_BATCH = 100;
const MAX_OUTBOX_ATTEMPTS = 5;
const INVALIDATE_CHUNK = 200;

/** Past-due grace window (subscription §6) — not 1 day, too short for Indian retail. */
const GRACE_DAYS = 7;

/**
 * Time-based subscription transitions have no event — a trial just ends when the
 * clock reaches `trial_ends_at`. This cron (every 5 min, subscription §19) fills
 * that gap. Each transition is a single atomic `UPDATE … WHERE <predicate>` in
 * the repo, so a duplicate/concurrent run is a no-op (idempotent). A Redis lock
 * further prevents two instances from doing redundant work + audit.
 *
 * A second job drains the subscription_audit_outbox into audit_logs.
 */
/** Last-run stats for a cron, surfaced via `getStats()` (PRD §11.3 /health/crons). */
export interface CronRunStats {
  lastRunAt:      Date | null;
  lastDurationMs: number;
  lastTransitions: number;
  lastError:      string | null;
}

@Injectable()
export class SubscriptionLifecycleCronService implements OnModuleInit {
  private readonly logger = new Logger(SubscriptionLifecycleCronService.name);

  private readonly stats: CronRunStats = {
    lastRunAt: null,
    lastDurationMs: 0,
    lastTransitions: 0,
    lastError: null,
  };

  /** Snapshot of the most recent reconcile run — for /health/crons. */
  getStats(): CronRunStats {
    return { ...this.stats };
  }

  constructor(
    private readonly repo: SubscriptionRepository,
    private readonly subscriptions: SubscriptionService,
    private readonly audit: AuditService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly uow: UnitOfWork,
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
    const startedMs = now.getTime();
    try {
      // Cancelled-at-period-end must be claimed BEFORE the past-due sweep so a
      // subscription the owner intentionally ended never gets mistaken for an
      // unpaid-renewal failure (the repo query already excludes it via
      // cancel_at_period_end=false, this ordering is belt-and-suspenders).
      // Each transition + its outbox rows commit in ONE transaction, so a crash
      // can't leave a transitioned subscription with no audit event (the row no
      // longer matches the WHERE predicate on the next tick, so it'd be lost).
      const cancelled = await this.runTransition('SUBSCRIPTION_CANCELLED', (tx) => this.repo.expireCancelledAtPeriodEnd(now, tx));
      const trialed   = await this.runTransition('SUBSCRIPTION_TRIAL_ENDED', (tx) => this.repo.expireTrials(now, tx));
      const pastDued  = await this.runTransition('SUBSCRIPTION_PAST_DUE',    (tx) => this.repo.expireActiveToPastDue(now, GRACE_DAYS, tx));
      const lapsed    = await this.runTransition('SUBSCRIPTION_GRACE_ENDED', (tx) => this.repo.expirePastDueGrace(now, tx));

      // Version was bumped in the UPDATE; invalidate caches post-commit so
      // devices see it fast. Chunked so a mass same-day expiry doesn't fire an
      // unbounded burst of Redis DELs at once.
      await this.invalidateCaches([...cancelled, ...trialed, ...pastDued, ...lapsed]);

      const transitions = cancelled.length + trialed.length + pastDued.length + lapsed.length;
      if (transitions) {
        this.logger.log(
          `Reconcile: cancelled=${cancelled.length} trial_ended=${trialed.length} past_due=${pastDued.length} grace_ended=${lapsed.length}`,
        );
      }
      this.stats.lastTransitions = transitions;
      this.stats.lastError = null;
    } catch (err) {
      this.stats.lastError = errorMessage(err);
      this.logger.error('Subscription reconcile failed', err);
    } finally {
      this.stats.lastRunAt = now;
      this.stats.lastDurationMs = Date.now() - startedMs;
      await this.redis.del(RECON_LOCK).catch(() => undefined);
    }
  }

  /** Run one set-based transition and enqueue its outbox rows atomically. */
  private async runTransition(
    eventType: string,
    transition: (tx: DbTransaction) => Promise<string[]>,
  ): Promise<string[]> {
    return this.uow.execute(async (tx) => {
      const accountIds = await transition(tx);
      await Promise.all(accountIds.map((id) => this.repo.enqueueOutbox(id, eventType, {}, tx)));
      return accountIds;
    });
  }

  /** Post-commit cache invalidation, chunked to bound the Redis fan-out. */
  private async invalidateCaches(accountIds: string[]): Promise<void> {
    for (let i = 0; i < accountIds.length; i += INVALIDATE_CHUNK) {
      const chunk = accountIds.slice(i, i + INVALIDATE_CHUNK);
      await Promise.all(chunk.map((id) => this.subscriptions.invalidateCache(id)));
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
          // Bounded retry: bump the attempt counter and dead-letter a poison row
          // after MAX_OUTBOX_ATTEMPTS so it can't head-of-line-block the queue
          // (findPendingOutbox is ORDER BY created_at LIMIT N).
          const attempts = await this.repo.incrementOutboxAttempt(row.id).catch(() => 0);
          if (attempts >= MAX_OUTBOX_ATTEMPTS) {
            await this.repo.deadLetterOutbox(row.id, new Date()).catch(() => undefined);
            this.logger.error(`Outbox row ${row.id} dead-lettered after ${attempts} attempts: ${errorMessage(err)}`);
          } else {
            this.logger.warn(`Outbox drain failed for ${row.id} (attempt ${attempts}): ${errorMessage(err)}`);
          }
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
