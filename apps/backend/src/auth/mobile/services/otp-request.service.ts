import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { CORE_REDIS } from '../../core/core.tokens.js';
import { RateLimitService } from '../../core/rate-limit.service.js';
import { AppConfigService } from '#config/app-config.service.js';
import {
  OtpRequestRepository,
  type OtpPurpose,
} from '../repositories/otp-request.repository.js';
import { OtpService } from './otp.service.js';
import { AppException } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';

export interface OtpRequestResult {
  otpRequestId: string;
  phoneMasked: string;
  expiresIn: number;
  resendAvailableIn: number;
  maxAttempts: number;
}

@Injectable()
export class OtpRequestService {
  constructor(
    @Inject(CORE_REDIS) private readonly redis: Redis,
    private readonly rateLimitService: RateLimitService,
    private readonly config: AppConfigService,
    private readonly otpRepo: OtpRequestRepository,
    private readonly otpService: OtpService,
  ) {}

  async requestOtp(
    phone: string,
    purpose: OtpPurpose,
    ip: string,
    resendOf?: string,
  ): Promise<OtpRequestResult> {
    await this.rateLimitService.checkIpLimit(ip);
    await this.rateLimitService.checkPhoneOtpLimit(phone);

    const lockKey = `otp_lock:${phone}:${purpose}`;
    const acquired = await this.redis.set(lockKey, '1', 'EX', 5, 'NX');
    if (!acquired)
      throw new AppException(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'Request in progress',
        429,
      );

    // Cooldown must be enforced unconditionally, keyed off server-known
    // state — a caller that simply omits `resendOf` previously skipped this
    // check entirely. When `resendOf` is supplied it's looked up scoped to
    // `phone` (defense against a guessed/foreign id); either way, absent a
    // usable `resendOf` row, fall back to the latest request for this
    // phone+purpose so the cooldown can't be bypassed by dropping the field.
    const prev = resendOf
      ? await this.otpRepo.findById(resendOf, phone)
      : await this.otpRepo.findLatestForPhone(phone, purpose);
    if (prev) {
      const elapsed = (Date.now() - prev.createdAt.getTime()) / 1000;
      if (elapsed < this.config.otpResendCooldownSeconds) {
        throw new AppException(
          ErrorCodes.RATE_LIMIT_EXCEEDED,
          'Resend not yet available — please wait before requesting another OTP',
          429,
        );
      }
    }

    const ttl = this.config.otpTtlSeconds;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const request = await this.otpRepo.insert({
      phone,
      purpose,
      maxAttempts: this.config.otpMaxAttempts,
      expiresAt,
    });

    // Redis key is scoped by this row's id (not phone+purpose) — see
    // otp.service.ts's otpKey — so sibling live requests for the same
    // phone+purpose never share a brute-forceable code/attempt budget.
    await this.otpService.generateAndSend(request.id, phone, ttl);

    await this.rateLimitService.recordAttempt({
      ip,
      phone,
      purpose,
      success: false,
    });

    return {
      otpRequestId: request.id,
      phoneMasked: this.maskPhone(phone),
      expiresIn: ttl,
      resendAvailableIn: this.config.otpResendCooldownSeconds,
      maxAttempts: this.config.otpMaxAttempts,
    };
  }

  private maskPhone(phone: string): string {
    if (phone.length <= 4) return '****';
    return phone.slice(0, -4).replace(/./g, '*') + phone.slice(-4);
  }
}
