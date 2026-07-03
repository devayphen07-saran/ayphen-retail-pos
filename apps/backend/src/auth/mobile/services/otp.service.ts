import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomInt, timingSafeEqual } from 'crypto';
import Redis from 'ioredis';
import { AppException } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { OtpRequestRepository, type OtpRequest } from '../repositories/otp-request.repository.js';
import { MOBILE_REDIS } from './redis.provider.js';

const devOtpKey = (phone: string) => `dev_otp:${phone}`;

/**
 * MSG91 sending is disabled for now — every environment generates the code
 * locally (Redis + console log). Re-wire Msg91Service.sendOtp here when
 * real SMS delivery is needed again.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @Inject(MOBILE_REDIS)     private readonly redis:   Redis,
    private readonly otpRepo: OtpRequestRepository,
  ) {}

  async generateAndSend(phone: string, ttlSeconds: number): Promise<string> {
    const code = String(randomInt(100_000, 999_999));

    await this.redis.setex(devOtpKey(phone), ttlSeconds, code);
    this.logger.log(`[dev] OTP for ${phone}: ${code}`);

    return code;
  }

  async verifyOtp(
    phone:     string,
    submitted: string,
    request:   OtpRequest,
  ): Promise<void> {
    if (request.consumedAt) {
      throw new AppException(ErrorCodes.TOKEN_INVALID, 'OTP_ALREADY_CONSUMED', 422);
    }
    if (request.attempts >= request.maxAttempts) {
      throw new AppException(ErrorCodes.TOKEN_INVALID, 'OTP_MAX_ATTEMPTS', 422);
    }
    if (new Date() > request.expiresAt) {
      throw new AppException(ErrorCodes.TOKEN_EXPIRED, 'OTP_EXPIRED', 422);
    }

    let valid = false;

    const stored = await this.redis.get(devOtpKey(phone));
    if (stored) {
      const a = Buffer.from(stored.padEnd(6));
      const b = Buffer.from(submitted.padEnd(6));
      valid = a.length === b.length && timingSafeEqual(a, b);
    }

    await this.otpRepo.incrementAttempts(request.id);

    if (!valid) {
      throw new AppException(ErrorCodes.INVALID_CREDENTIALS, 'OTP_INVALID', 422);
    }

    await this.otpRepo.markConsumed(request.id);
  }
}
