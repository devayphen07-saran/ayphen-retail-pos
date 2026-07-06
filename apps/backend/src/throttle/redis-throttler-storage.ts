import type { ThrottlerStorage } from '@nestjs/throttler';
import type Redis from 'ioredis';

/** Structural mirror of @nestjs/throttler's ThrottlerStorageRecord (not exported
 *  from the package index). `implements ThrottlerStorage` still checks the shape. */
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis-backed throttler storage so rate limits are cluster-wide (not per
 * instance) and survive restarts — the in-memory default resets on restart and
 * gives every replica its own counter, so N replicas allow N× the intended
 * limit. Reuses the single shared MOBILE_REDIS connection (no second client).
 *
 * The Lua script replicates @nestjs/throttler's in-memory ThrottlerStorageService
 * semantics atomically: a fixed TTL window with an optional block window. `ttl`
 * and `blockDuration` arrive in milliseconds; `timeToExpire`/`timeToBlockExpire`
 * are returned in whole seconds (ceil), matching the built-in storage.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  // KEYS[1] = record key; ARGV = [ttlMs, limit, blockMs]. Uses Redis TIME so all
  // replicas share one clock. Returns {totalHits, timeToExpire, isBlocked(0|1),
  // timeToBlockExpire}.
  private static readonly SCRIPT = `
    local key   = KEYS[1]
    local ttl   = tonumber(ARGV[1])
    local limit = tonumber(ARGV[2])
    local block = tonumber(ARGV[3])

    local t   = redis.call('TIME')
    local now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)

    local exists = redis.call('EXISTS', key) == 1
    local totalHits      = exists and tonumber(redis.call('HGET', key, 'totalHits'))      or 0
    local expiresAt      = exists and tonumber(redis.call('HGET', key, 'expiresAt'))      or (now + ttl)
    local blockExpiresAt = exists and tonumber(redis.call('HGET', key, 'blockExpiresAt')) or 0
    local isBlocked      = exists and tonumber(redis.call('HGET', key, 'isBlocked'))      or 0

    local timeToExpire = math.ceil((expiresAt - now) / 1000)
    if timeToExpire <= 0 then
      expiresAt = now + ttl
      timeToExpire = math.ceil((expiresAt - now) / 1000)
    end

    if isBlocked == 0 then
      totalHits = totalHits + 1
    end

    if totalHits > limit and isBlocked == 0 then
      isBlocked = 1
      blockExpiresAt = now + block
    end

    local timeToBlockExpire = math.ceil((blockExpiresAt - now) / 1000)
    if timeToBlockExpire <= 0 and isBlocked == 1 then
      isBlocked = 0
      totalHits = 1
      timeToBlockExpire = 0
    end

    redis.call('HSET', key,
      'totalHits', totalHits,
      'expiresAt', expiresAt,
      'blockExpiresAt', blockExpiresAt,
      'isBlocked', isBlocked)

    local pttl = ttl
    if isBlocked == 1 and (blockExpiresAt - now) > pttl then
      pttl = blockExpiresAt - now
    end
    redis.call('PEXPIRE', key, pttl)

    return { totalHits, timeToExpire, isBlocked, timeToBlockExpire }
  `;

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const result = (await this.redis.eval(
      RedisThrottlerStorage.SCRIPT,
      1,
      `throttle:${throttlerName}:${key}`,
      ttl,
      limit,
      blockDuration,
    )) as [number, number, number, number];

    return {
      totalHits:         result[0],
      timeToExpire:      result[1],
      isBlocked:         result[2] === 1,
      timeToBlockExpire: result[3],
    };
  }
}