import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { AppException } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { CORE_REDIS } from './core.tokens.js';
import { RateLimitRepository } from './rate-limit.repository.js';
import { AuthConstantsService } from './auth-constants.service.js';

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
    private readonly repo:      RateLimitRepository,
    private readonly constants: AuthConstantsService,
  ) {}

  async checkIpLimit(ip: string): Promise<void> {
    await this.enforce(
      `rl:ip:${ip}`,
      IP_WINDOW_SECONDS,
      this.constants.IP_MAX_ATTEMPTS,
      () => this.repo.countIpAttempts(ip),
      'Too many requests from this IP — please wait before retrying',
    );
  }

  async checkPhoneOtpLimit(phone: string): Promise<void> {
    await this.enforce(
      `rl:otp:${phone}`,
      PHONE_WINDOW_SECONDS,
      this.constants.OTP_MAX_ATTEMPTS,
      () => this.repo.countPhoneOtpAttempts(phone),
      'Too many OTP requests for this phone — please wait before retrying',
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
    dbCount: () => Promise<number>,
    message: string,
  ): Promise<void> {
    const redisCount = await this.incrWindow(key, windowSeconds);

    if (redisCount !== null) {
      // INCR counts THIS request too, so block strictly above the limit —
      // parity with the DB path, which counts only prior recorded attempts.
      if (redisCount > limit) this.reject(message);
      return;
    }

    // Redis unavailable — enforce off the audit table like before.
    const count = await dbCount();
    if (count >= limit) this.reject(message);
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
