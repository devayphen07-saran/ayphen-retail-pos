import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { z, type ZodType } from 'zod';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { accountSubscriptions } from '#db/schema.js';
import { REDIS } from '#common/redis/redis.provider.js';
import { readTypedCache } from '#common/redis/typed-cache.js';
import { ErrorCodes } from '#common/error-codes.js';
import type { ResolvedStoreContext } from '#common/rbac/resolved-store-context.js';
import {
  subVersionPointerKey,
  subSnapshotKey,
  SUB_CACHE_TTL_SECONDS,
} from '../../../subscription/subscription-cache.js';

export const ALLOW_EXPIRED_SUBSCRIPTION_KEY = 'allowExpiredSubscription';

/** Decorate read-only handlers to let them through even on expired accounts. */
export const AllowExpiredSubscription = () =>
  Reflect.metadata(ALLOW_EXPIRED_SUBSCRIPTION_KEY, true);

/** The `account_subscriptions.status` / `reconciliation_status` enums (schema.ts).
 *  The write-gate switches exhaustively over these, so adding a status is a
 *  compile error at the gate rather than a silent fall-through that opens it. */
const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired'] as const;
type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

const RECONCILIATION_STATUSES = ['none', 'pending', 'applied'] as const;
type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

/** HTTP methods that never touch the write-gate (reads are never blocked). */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Snapshot of the fields the guard needs — cached in Redis, keyed per account. */
interface SubscriptionSnapshot {
  status:               SubscriptionStatus;
  accessValidUntil:     string | null; // ISO
  subscriptionVersion:  number;
  reconciliationStatus: ReconciliationStatus;
}

const SubscriptionSnapshotSchema: ZodType<SubscriptionSnapshot> = z.object({
  status: z.enum(SUBSCRIPTION_STATUSES),
  accessValidUntil: z.string().nullable(),
  subscriptionVersion: z.number(),
  reconciliationStatus: z.enum(RECONCILIATION_STATUSES),
});

/**
 * Freshness signal stashed on the request by this guard so the response
 * interceptor can emit `X-Subscription-Version` / `X-Subscription-Warning`
 * headers (subscription §19; device §30.5 depends on the warning header).
 */
export interface SubscriptionFreshness {
  version: number;
  /** e.g. `trialing:ends_at_2026-07-16T00:00:00Z`, or undefined when calm. */
  warning?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      subscriptionFreshness?: SubscriptionFreshness;
    }
  }
}

/**
 * Blocks mutating requests when the account subscription has lapsed, and stamps
 * the request with the current subscription version + any grace/cancel warning
 * so downstream can surface freshness headers.
 *
 * Runs AFTER the tenant guard, which attaches the resolved store context
 * (`request.context`). Reads (GET/HEAD/OPTIONS) and handlers decorated with
 * `@AllowExpiredSubscription()` skip the block — reads are never gated.
 *
 * The subscription snapshot is cached in Redis under `sub:{accountId}` (5-min
 * TTL) to collapse the store→account→subscription lookup to a cache hit on the
 * hot path. Phase B will switch to the versioned key `sub:{accountId}:v{n}` and
 * invalidate it on every `subscription_version` bump.
 */
@Injectable()
export class SubscriptionStatusGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowExpired = this.reflector.getAllAndOverride<boolean>(
      ALLOW_EXPIRED_SUBSCRIPTION_KEY,
      [context.getHandler(), context.getClass()],
    );

    const req       = context.switchToHttp().getRequest<Request>();
    const accountId = this.resolveAccountId(req);
    if (!accountId) {
      // Guard applied without a tenant guard ahead of it — fail safe.
      throw new ForbiddenException(ErrorCodes.STORE_CONTEXT_MISSING);
    }

    const sub = await this.loadSubscription(accountId);
    if (!sub) {
      throw new ForbiddenException(ErrorCodes.SUBSCRIPTION_NOT_FOUND);
    }

    // Freshness is emitted on every request (even reads / allow-expired) so the
    // client keeps its cached window current.
    const freshness: SubscriptionFreshness = {
      version: sub.subscriptionVersion,
      warning: this.buildWarning(sub),
    };
    req.subscriptionFreshness = freshness;

    // Stamp the headers here too, not only via SubscriptionHeadersInterceptor:
    // when this guard throws below, NestJS never invokes that interceptor
    // (guards run before interceptors; a guard rejection skips the handler
    // pipeline entirely) — so the 402/403 responses that most need the client
    // to learn the current version/warning would otherwise carry neither.
    // Harmless on the allow-through path: the interceptor sets the identical
    // values again once the handler completes.
    this.stampHeaders(context, freshness);

    const isRead = READ_METHODS.has(req.method);
    if (isRead || allowExpired) return true;

    // Status gate — exhaustive over the enum so a newly-added status is a
    // compile error here, never a silent fall-through that opens the write-gate.
    switch (sub.status) {
      // Admin/abuse suspension blocks writes regardless of the access window
      // (subscription.md §4/§7). Wire code `subscription_suspended`, 403.
      case 'paused':
        throw new ForbiddenException(ErrorCodes.SUBSCRIPTION_SUSPENDED);
      // Definitively inactive — grace-over / cancelled-period-over collapse to
      // `expired`. Wire code `subscription_payment_required`, 402.
      case 'expired':
        throw new HttpException(ErrorCodes.SUBSCRIPTION_PAYMENT_REQUIRED, HttpStatus.PAYMENT_REQUIRED);
      // Still within (or possibly within) the access window — fall through to
      // the window / reconciliation / store-lock checks below. `cancelled`
      // stays usable until its period end via the accessValidUntil check.
      case 'trialing':
      case 'active':
      case 'past_due':
      case 'cancelled':
        break;
      default: {
        const unreachable: never = sub.status;
        throw new Error(`Unhandled subscription status: ${String(unreachable)}`);
      }
    }

    // Soft block: access window closed (trial ended / paid period over) but the
    // status hasn't flipped yet (reconciliation cron lag) — same wire contract.
    if (sub.accessValidUntil && new Date(sub.accessValidUntil) < new Date()) {
      throw new HttpException(ErrorCodes.SUBSCRIPTION_PAYMENT_REQUIRED, HttpStatus.PAYMENT_REQUIRED);
    }

    // A downgrade left some resource (stores/devices) over its new
    // limit — every write is blocked account-wide until the owner resolves
    // which to keep (POST /subscription/reconciliation). Reads always work.
    if (sub.reconciliationStatus === 'pending') {
      throw new ForbiddenException(ErrorCodes.SUBSCRIPTION_RECONCILIATION_REQUIRED);
    }

    // Store-level lock (downgrade-reconciliation §5, applied and permanent
    // until the owner unlocks or upgrades — independent of the account-wide
    // pending gate above, which only covers the *unresolved* window). Checked
    // here rather than a separate guard since this is already the single
    // write-gate chokepoint every mutating store-scoped route passes through.
    const storeContext = (req as Request & { context?: ResolvedStoreContext }).context;
    if (storeContext?.isLocked) {
      throw new ForbiddenException(ErrorCodes.STORE_LOCKED);
    }

    return true;
  }

  private resolveAccountId(req: Request): string | undefined {
    const resolved = (req as Request & { context?: ResolvedStoreContext }).context;
    return resolved?.accountId;
  }

  /** Same header contract as `SubscriptionHeadersInterceptor` — duplicated
   *  here only for the guard-throws path that interceptor can't reach. */
  private stampHeaders(context: ExecutionContext, freshness: SubscriptionFreshness): void {
    const res = context.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;
    res.setHeader('X-Subscription-Version', String(freshness.version));
    if (freshness.warning) {
      res.setHeader('X-Subscription-Warning', freshness.warning);
    }
  }

  /**
   * Cache-aside read of the per-account subscription snapshot using the versioned
   * key scheme (subscription §19): follow the version pointer to a version-pinned
   * snapshot; on any miss, read DB and repopulate both. A stale pointer/snapshot
   * simply misses after the writer advances the version.
   */
  private async loadSubscription(
    accountId: string,
  ): Promise<SubscriptionSnapshot | null> {
    try {
      const version = await this.redis.get(subVersionPointerKey(accountId));
      if (version) {
        const cached = await readTypedCache(
          this.redis,
          subSnapshotKey(accountId, Number(version)),
          SubscriptionSnapshotSchema,
        );
        if (cached) return cached;
      }
    } catch {
      // Corrupt/unavailable cache → fall through to DB (never block on cache).
    }

    const [row] = await this.db
      .select({
        status:               accountSubscriptions.status,
        accessValidUntil:     accountSubscriptions.accessValidUntil,
        subscriptionVersion:  accountSubscriptions.subscriptionVersion,
        reconciliationStatus: accountSubscriptions.reconciliationStatus,
      })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountFk, accountId));

    if (!row) return null;

    const snapshot: SubscriptionSnapshot = {
      status:               row.status,
      accessValidUntil:     row.accessValidUntil?.toISOString() ?? null,
      subscriptionVersion:  row.subscriptionVersion,
      reconciliationStatus: row.reconciliationStatus,
    };

    try {
      await this.redis
        .multi()
        .set(subSnapshotKey(accountId, snapshot.subscriptionVersion), JSON.stringify(snapshot), 'EX', SUB_CACHE_TTL_SECONDS)
        .set(subVersionPointerKey(accountId), String(snapshot.subscriptionVersion), 'EX', SUB_CACHE_TTL_SECONDS)
        .exec();
    } catch {
      // Cache write is best-effort.
    }

    return snapshot;
  }

  /** Build the `X-Subscription-Warning` value, or undefined when nothing to warn. */
  private buildWarning(sub: SubscriptionSnapshot): string | undefined {
    if (sub.status === 'trialing' && sub.accessValidUntil) {
      return `trialing:ends_at_${sub.accessValidUntil}`;
    }
    // In the 7-day past_due grace window — full access, but warn so the client
    // can show "renew before {grace_until}" (subscription §11, device §30.5).
    if (sub.status === 'past_due' && sub.accessValidUntil) {
      return `past_due:grace_until_${sub.accessValidUntil}`;
    }
    return undefined;
  }
}
