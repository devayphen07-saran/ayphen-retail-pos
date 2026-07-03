import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import { AppException } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { devices, users } from '#db/schema.js';
import { AuthConstantsService } from '../../core/auth-constants.service.js';
import { CryptoService } from '../../core/crypto.service.js';
import { OtpService } from './otp.service.js';
import { OtpRequestRepository } from '../repositories/otp-request.repository.js';
import { AuthSessionRepository } from '../repositories/auth-session.repository.js';
import { DeviceChallengeService } from './device-challenge.service.js';
import { SessionCacheInvalidatorService } from './session-cache-invalidator.service.js';
import { MOBILE_REDIS } from './redis.provider.js';

const stepUpKey = (sessionId: string) => `stepup:attempts:${sessionId}`;

export interface StepUpDto {
  method:                  'otp_sms' | 'biometric' | 'totp' | 'password_reentry';
  credential:              string;
  otpRequestId?:           string;
  challengeId?:            string;
  intendedWindowSeconds?:  number;
}

export interface StepUpResult {
  ok:          true;
  method:      string;
  completedAt: Date;
  validUntil:  Date;
}

@Injectable()
export class StepUpService {
  constructor(
    @Inject(MOBILE_REDIS)         private readonly redis:      Redis,
    @Inject(DRIZZLE)              private readonly db:         PostgresJsDatabase<typeof schema>,
    private readonly constants:   AuthConstantsService,
    private readonly crypto:      CryptoService,
    private readonly otpService:  OtpService,
    private readonly otpRepo:     OtpRequestRepository,
    private readonly sessionRepo: AuthSessionRepository,
    private readonly challenge:   DeviceChallengeService,
    private readonly cacheInvalidator: SessionCacheInvalidatorService,
  ) {}

  async verify(
    userId:          string,
    deviceSessionId: string,
    dto:             StepUpDto,
  ): Promise<StepUpResult> {
    const session = await this.sessionRepo.findById(deviceSessionId);
    if (!session) throw new UnauthorizedException('SESSION_REVOKED');

    // Resolve phone and publicKey from DB — never trust caller-supplied values
    const [[user], [device]] = await Promise.all([
      this.db.select({ phone: users.phone }).from(users).where(eq(users.id, userId)),
      this.db.select({ publicKey: devices.publicKey }).from(devices).where(eq(devices.id, session.deviceFk)),
    ]);
    if (!user?.phone)      throw new UnauthorizedException('USER_NOT_FOUND');
    if (!device?.publicKey) throw new UnauthorizedException('DEVICE_NOT_FOUND');
    const phone     = user.phone;
    const publicKey = device.publicKey;

    // 1. Rate limit check (Redis + DB)
    if (session.stepUpLockedUntil && session.stepUpLockedUntil > new Date()) {
      throw new AppException(ErrorCodes.RATE_LIMIT_EXCEEDED, 'STEP_UP_LOCKED', 429);
    }

    const attemptsKey = stepUpKey(deviceSessionId);

    try {
      await this.verifyMethod(phone, publicKey, dto);
    } catch (err) {
      const count = await this.redis.incr(attemptsKey);
      await this.redis.expire(attemptsKey, this.constants.STEP_UP_RATE_WINDOW_SECONDS);

      if (count >= this.constants.STEP_UP_MAX_ATTEMPTS) {
        const lockedUntil = new Date(
          Date.now() + this.constants.STEP_UP_RATE_WINDOW_SECONDS * 1000,
        );
        await this.sessionRepo.setStepUpLockedUntil(deviceSessionId, lockedUntil);
        await this.cacheInvalidator.invalidate(deviceSessionId);
      }
      throw err;
    }

    // 4. Success
    await this.redis.del(attemptsKey);
    const now        = new Date();
    const window     = dto.intendedWindowSeconds ?? this.constants.STEP_UP_VALIDITY_SECONDS;
    const validUntil = new Date(now.getTime() + window * 1000);

    await this.sessionRepo.updateStepUp(deviceSessionId, dto.method, now);
    await this.cacheInvalidator.invalidate(deviceSessionId);

    return { ok: true, method: dto.method, completedAt: now, validUntil };
  }

  private async verifyMethod(phone: string, publicKey: string, dto: StepUpDto): Promise<void> {
    switch (dto.method) {
      case 'otp_sms': {
        if (!dto.otpRequestId) throw new AppException(ErrorCodes.VALIDATION_FAILED, 'otp_request_id required', 422);
        const req = await this.otpRepo.findActiveRequest(dto.otpRequestId, phone);
        if (!req) throw new AppException(ErrorCodes.TOKEN_EXPIRED, 'OTP_EXPIRED', 422);
        await this.otpService.verifyOtp(phone, dto.credential, req);
        break;
      }
      case 'biometric': {
        if (!dto.challengeId) throw new AppException(ErrorCodes.VALIDATION_FAILED, 'challenge_id required', 422);
        await this.challenge.consumeChallenge(dto.challengeId);
        const ok = await this.crypto.verifyDeviceSignature(publicKey, dto.challengeId, dto.credential);
        if (!ok) throw new UnauthorizedException('DEVICE_SIGNATURE_INVALID');
        break;
      }
      default:
        throw new AppException(ErrorCodes.VALIDATION_FAILED, 'Unsupported step-up method', 422);
    }
  }
}
