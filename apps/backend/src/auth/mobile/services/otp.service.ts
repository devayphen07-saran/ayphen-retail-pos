import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomInt, timingSafeEqual } from 'crypto';
import Redis from 'ioredis';
import { AppException } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { AppConfigService } from '#config/app-config.service.js';
import { CryptoService } from '../../core/crypto.service.js';
import { Msg91Service } from '../../core/msg91.service.js';
import { OtpRequestRepository, type OtpRequest } from '../repositories/otp-request.repository.js';
import { REDIS } from '#common/redis/redis.provider.js';

// Scoped by the otpRequests row id — NOT by (phone, purpose). Multiple live
// rows can exist for the same phone+purpose (e.g. two resends before the
// first expires), each with its own independent `maxAttempts` counter in the
// DB. Keying the code by (phone, purpose) let all of those rows share a
// single Redis code, so their attempt budgets summed instead of each row
// bounding its own — multiplying the effective brute-force budget. Scoping by
// request id gives each row its own code, closing that amplification and
// also fixing "used code still verifies a different still-live sibling row"
// (see verifyOtp, which now also deletes this key on success).
const otpKey = (requestId: string) => `otp:${requestId}`;

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @Inject(REDIS)     private readonly redis:   Redis,
    private readonly otpRepo:  OtpRequestRepository,
    private readonly config:   AppConfigService,
    private readonly crypto:   CryptoService,
    private readonly msg91:    Msg91Service,
  ) {}

  async generateAndSend(requestId: string, phone: string, ttlSeconds: number): Promise<string> {
    const code = String(randomInt(100_000, 999_999));

    // Store only a HASH at rest — a Redis read never yields a usable code.
    await this.redis.setex(otpKey(requestId), ttlSeconds, this.crypto.hashToken(code));

    if (this.config.isProduction) {
      // Real delivery. Throws OTP_SEND_FAILED on gateway error, so the caller
      // fails closed (no usable OTP request is left behind).
      await this.msg91.sendOtp(phone, code);
    } else {
      // Dev/test only — no SMS gateway. NEVER log the code in production.
      this.logger.log(`[dev] OTP for ${phone}: ${code}`);
    }

    return code;
  }

  async verifyOtp(
    phone:     string,
    submitted: string,
    request:   OtpRequest,
  ): Promise<void> {
    if (request.consumedAt) {
      throw new AppException(ErrorCodes.OTP_INVALID, 'OTP has already been used', 422);
    }
    if (new Date() > request.expiresAt) {
      throw new AppException(ErrorCodes.OTP_EXPIRED, 'OTP has expired', 422);
    }

    // Atomic check-and-increment: the DB row, not this in-memory `request`
    // snapshot, is the source of truth for the attempt count — closes the
    // race where concurrent verify calls each read a stale `attempts` value
    // and jointly exceed maxAttempts before either's increment commits.
    const attempt = await this.otpRepo.incrementAttemptsIfUnderLimit(request.id);
    if (!attempt.underLimit) {
      throw new AppException(ErrorCodes.OTP_MAX_ATTEMPTS, 'Too many incorrect OTP attempts', 422);
    }
    const attemptsRemaining = attempt.maxAttempts - attempt.attempts;

    let valid = false;

    const storedHash = await this.redis.get(otpKey(request.id));
    if (storedHash) {
      const a = Buffer.from(storedHash);
      const b = Buffer.from(this.crypto.hashToken(submitted));
      valid = a.length === b.length && timingSafeEqual(a, b);
    }

    if (!valid) {
      throw new AppException(ErrorCodes.OTP_INVALID, 'Incorrect OTP', 422, { attemptsRemaining });
    }

    await this.otpRepo.markConsumed(request.id);
    // One-time-use: remove the code so it can't be replayed against this
    // (now-consumed) row, and — belt-and-suspenders with the id-scoped key
    // above — can never be reused against any other row either.
    await this.redis.del(otpKey(request.id));
  }
}
