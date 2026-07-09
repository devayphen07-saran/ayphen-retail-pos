import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { AppException } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { AppConfigService } from '#config/app-config.service.js';
import { CORE_REDIS } from './core.tokens.js';
import { RateLimitRepository } from './rate-limit.repository.js';

/** Window sizes mirror the repository's SQL intervals — the DB count is the
 *  fallback read path when Redis is unavailable, so the two must agree. */
const IP_WINDOW_SECONDS = 60;
const PHONE_WINDOW_SECONDS = 300;

/** Atomic INCR + EXPIRE-if-new. Two separate round-trips would leave a
 *  TTL-less counter behind if the process died between them — a key that
 *  never expires is a permanent rate-limit lockout for that IP/phone. */
const INCR_WITH_TTL_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return c
`;

/**
 * Enforcement reads from Redis fixed-window counters (O(1), atomic); the
 * loginAttempts table stays as the audit trail via recordAttempt(), not the
 * hot read path. Redis failure falls back to the original DB COUNT — the
 * limiter degrades to the slower path, it never fails open.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(
    @Inject(CORE_REDIS) private readonly redis: Redis,
    private readonly repo:   RateLimitRepository,
    private readonly config: AppConfigService,
  ) {}

  async checkIpLimit(ip: string): Promise<void> {
    await this.enforce(
      `rl:ip:${ip}`,
      IP_WINDOW_SECONDS,
      this.config.ipMaxAttempts,
      'Too many requests from this IP — please wait before retrying',
    );
  }

  async checkPhoneOtpLimit(phone: string): Promise<void> {
    await this.enforce(
      `rl:otp:${phone}`,
      PHONE_WINDOW_SECONDS,
      this.config.otpMaxAttempts,
      'Too many OTP requests for this phone — please wait before retrying',
    );
  }

  /** Generic identity-scoped limiter for a specific action — e.g. checkout,
   *  which triggers a real outbound payment-gateway call per invocation and
   *  isn't covered by the global per-IP throttler (mobile-carrier NAT means
   *  one IP is thousands of legitimate users; see ThrottleModule's comment).
   *  `action` namespaces the Redis key so different actions don't share a
   *  counter. */
  async checkAccountActionLimit(
    accountId: string,
    action: string,
    windowSeconds: number,
    limit: number,
  ): Promise<void> {
    await this.enforce(
      `rl:acct:${action}:${accountId}`,
      windowSeconds,
      limit,
      'Too many requests — please wait before retrying',
    );
  }

  async recordAttempt(entry: {
    ip:      string;
    userId?: string;
    email?:  string;
    phone?:  string;
    purpose: string;
    success: boolean;
  }): Promise<void> {
    await this.repo.insert(entry);
  }

  private async enforce(
    key: string,
    windowSeconds: number,
    limit: number,
    message: string,
  ): Promise<void> {
    const redisCount = await this.incrWindow(key, windowSeconds);

    if (redisCount !== null) {
      // INCR counts THIS request too, so block strictly above the limit —
      // parity with the DB fallback below, which also counts this request.
      if (redisCount > limit) this.reject(message);
      return;
    }

    // Redis unavailable — atomic Postgres fixed-window counter (see
    // RateLimitRepository.incrementFallbackWindow for why this must be an
    // atomic increment, not a "SELECT COUNT then decide" read).
    const windowMs = windowSeconds * 1000;
    const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
    const dbCount = await this.repo.incrementFallbackWindow(key, windowStart);
    if (dbCount > limit) this.reject(message);
  }

  /** Returns the post-increment count, or null when Redis is unreachable. */
  private async incrWindow(key: string, windowSeconds: number): Promise<number | null> {
    try {
      const result = await this.redis.eval(INCR_WITH_TTL_LUA, 1, key, windowSeconds);
      return Number(result);
    } catch {
      this.logger.warn(`Rate-limit Redis unavailable, falling back to DB count (${key})`);
      return null;
    }
  }

  private reject(message: string): never {
    throw new AppException(ErrorCodes.RATE_LIMIT_EXCEEDED, message, 429);
  }
}
