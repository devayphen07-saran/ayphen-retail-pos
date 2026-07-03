import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { accountSubscriptions } from '#db/schema.js';
import { MOBILE_REDIS } from '../services/redis.provider.js';
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

/** Statuses that block writes regardless of the access window. */
const BLOCKING_STATUSES = new Set(['expired']);

/** HTTP methods that never touch the write-gate (reads are never blocked). */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Snapshot of the fields the guard needs — cached in Redis, keyed per account. */
interface SubscriptionSnapshot {
  status:              string;
  accessValidUntil:    string | null; // ISO
  subscriptionVersion: number;
}

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
    @Inject(MOBILE_REDIS) private readonly redis: Redis,
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
      throw new ForbiddenException('STORE_CONTEXT_MISSING');
    }

    const sub = await this.loadSubscription(accountId);
    if (!sub) {
      throw new ForbiddenException('SUBSCRIPTION_NOT_FOUND');
    }

    // Freshness is emitted on every request (even reads / allow-expired) so the
    // client keeps its cached window current.
    req.subscriptionFreshness = {
      version: sub.subscriptionVersion,
      warning: this.buildWarning(sub),
    };

    const isRead = READ_METHODS.has(req.method);
    if (isRead || allowExpired) return true;

    // Hard block: status is definitively inactive.
    if (BLOCKING_STATUSES.has(sub.status)) {
      throw new ForbiddenException('SUBSCRIPTION_INACTIVE');
    }

    // Soft block: access window closed (trial ended / paid period over).
    if (sub.accessValidUntil && new Date(sub.accessValidUntil) < new Date()) {
      throw new ForbiddenException('SUBSCRIPTION_ACCESS_EXPIRED');
    }

    return true;
  }

  private resolveAccountId(req: Request): string | undefined {
    const resolved = (req as Request & { context?: ResolvedStoreContext }).context;
    return resolved?.accountId;
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
        const cached = await this.redis.get(subSnapshotKey(accountId, Number(version)));
        if (cached) return JSON.parse(cached) as SubscriptionSnapshot;
      }
    } catch {
      // Corrupt/unavailable cache → fall through to DB (never block on cache).
    }

    const [row] = await this.db
      .select({
        status:              accountSubscriptions.status,
        accessValidUntil:    accountSubscriptions.accessValidUntil,
        subscriptionVersion: accountSubscriptions.subscriptionVersion,
      })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountFk, accountId));

    if (!row) return null;

    const snapshot: SubscriptionSnapshot = {
      status:              row.status,
      accessValidUntil:    row.accessValidUntil?.toISOString() ?? null,
      subscriptionVersion: row.subscriptionVersion,
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
    // Only the trial countdown remains a warning in this flow (no recurrence/
    // grace/cancel states). Lets the client show the trial-ending banner.
    if (sub.status === 'trialing' && sub.accessValidUntil) {
      return `trialing:ends_at_${sub.accessValidUntil}`;
    }
    return undefined;
  }
}
