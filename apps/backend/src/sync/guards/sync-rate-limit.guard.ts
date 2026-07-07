import { CanActivate, ExecutionContext, Inject, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type Redis from 'ioredis';
import { REDIS } from '#common/redis/redis.provider.js';
import { RateLimitError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import {
  SYNC_CHANGES_RATE_LIMIT,
  SYNC_DELTA_RATE_LIMIT,
  SYNC_MUTATION_RATE_LIMIT,
} from '../sync.constants.js';

export type SyncRateLimitBucket = 'changes' | 'delta';

const SYNC_RATE_LIMIT_BUCKET = 'syncRateLimitBucket';

/** Tag a sync route with its rate-limit bucket; undecorated routes (e.g.
 *  /sync/initial, whose cold-start cost is already bounded by page size, and
 *  /sync/conflicts) pass through the guard untouched. */
export const SyncRateLimit = (bucket: SyncRateLimitBucket) => SetMetadata(SYNC_RATE_LIMIT_BUCKET, bucket);

const BUCKET_LIMITS: Record<SyncRateLimitBucket, { windowSeconds: number; limit: number }> = {
  changes: SYNC_CHANGES_RATE_LIMIT,
  delta:   SYNC_DELTA_RATE_LIMIT,
};

/** Atomic INCR(BY) + EXPIRE-if-new — same shape as auth/core/rate-limit.service.ts. */
const INCR_BY_WITH_TTL_LUA = `
local c = redis.call('INCRBY', KEYS[1], ARGV[2])
if c == tonumber(ARGV[2]) then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return c
`;

/**
 * Per-(user, store, device, endpoint) abuse control for the sync surface
 * (sync-engine.md §16) — distinct from the global per-IP DDoS backstop in
 * ThrottleModule, which mobile carrier-NAT traffic makes useless as an
 * identity-scoped control. Keyed per DEVICE, not just per (user, store): one
 * owner logged into 2-3 counter devices must not throttle those devices
 * against each other at rush hour.
 *
 * Fails OPEN on a Redis error — this is an abuse control, not an authz
 * decision; the global per-IP throttler still bounds worst-case load.
 */
@Injectable()
export class SyncRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(SyncRateLimitGuard.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const bucket = this.reflector.get<SyncRateLimitBucket | undefined>(
      SYNC_RATE_LIMIT_BUCKET,
      context.getHandler(),
    );
    if (!bucket) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.user?.userId;
    const deviceId = req.user?.deviceId;
    const storeId = req.params?.storeId;
    // Missing identity means MobileJwtGuard/TenantGuard haven't run yet or
    // will reject this request themselves — nothing for this guard to do.
    if (!userId || !deviceId || !storeId) return true;

    const { windowSeconds, limit } = BUCKET_LIMITS[bucket];
    await this.enforce(`sync_rate_limit:${userId}:${storeId}:${deviceId}:${bucket}`, windowSeconds, limit, 1);

    if (bucket === 'delta') {
      const mutations = (req.body as { mutations?: unknown[] } | undefined)?.mutations;
      const count = Array.isArray(mutations) ? mutations.length : 0;
      if (count > 0) {
        await this.enforce(
          `sync_mutations:${userId}:${storeId}:${deviceId}`,
          SYNC_MUTATION_RATE_LIMIT.windowSeconds,
          SYNC_MUTATION_RATE_LIMIT.limit,
          count,
        );
      }
    }

    return true;
  }

  private async enforce(key: string, windowSeconds: number, limit: number, incrBy: number): Promise<void> {
    let count: number;
    try {
      count = Number(await this.redis.eval(INCR_BY_WITH_TTL_LUA, 1, key, windowSeconds, incrBy));
    } catch (err) {
      this.logger.warn(
        `Sync rate-limit Redis unavailable, failing open (${key}): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return;
    }
    if (count > limit) {
      throw new RateLimitError(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'Too many sync requests — please slow down and retry shortly',
      );
    }
  }
}
