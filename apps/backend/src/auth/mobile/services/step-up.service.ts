import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { AppException, UnauthorizedError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { AppConfigService } from '#config/app-config.service.js';
import { CryptoService } from '../../core/crypto.service.js';
import { RateLimitService } from '../../core/rate-limit.service.js';
import { OtpService } from './otp.service.js';
import { OtpRequestRepository } from '../repositories/otp-request.repository.js';
import { AuthSessionRepository, type DeviceSession } from '../repositories/auth-session.repository.js';
import { UserRepository } from '../repositories/user.repository.js';
import { DeviceRepository } from '../repositories/device.repository.js';
import { DeviceChallengeService } from './device-challenge.service.js';
import { SessionCacheInvalidatorService } from './session-cache-invalidator.service.js';
import { REDIS } from '#common/redis/redis.provider.js';

const stepUpKey = (sessionId: string) => `stepup:attempts:${sessionId}`;

/** DTO method → DB column vocabulary. Deliberately not a blind cast: the two
 *  enums have drifted ('otp_sms' vs 'otp'). */
const DTO_TO_DB_STEP_UP_METHOD: Record<
  StepUpDto['method'], NonNullable<DeviceSession['lastStepUpMethod']>
> = {
  otp_sms: 'otp',
  biometric: 'biometric',
};

export interface StepUpDto {
  method:                  'otp_sms' | 'biometric';
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
    @Inject(REDIS)         private readonly redis:      Redis,
    private readonly userRepo:    UserRepository,
    private readonly deviceRepo:  DeviceRepository,
    private readonly config:      AppConfigService,
    private readonly crypto:      CryptoService,
    private readonly rateLimit:   RateLimitService,
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
    // findById returns the row regardless of revocation status — a revoked
    // session is a row with revokedAt set, not a deleted row — so the null
    // check alone let a revoked session still complete step-up.
    if (!session || session.revokedAt) throw new UnauthorizedError(ErrorCodes.SESSION_REVOKED, 'Session has been revoked');

    // Resolve phone and publicKey from DB — never trust caller-supplied values
    const [user, device] = await Promise.all([
      this.userRepo.findById(userId),
      this.deviceRepo.findById(session.deviceFk),
    ]);
    if (!user?.phone)      throw new UnauthorizedError(ErrorCodes.USER_NOT_FOUND, 'User account not found');
    if (!device?.publicKey) throw new UnauthorizedError(ErrorCodes.DEVICE_NOT_FOUND, 'Device not found');
    const phone     = user.phone;
    const publicKey = device.publicKey;

    // Rate-limit lockout gate (Redis counter + DB-persisted lock window).
    if (session.stepUpLockedUntil && session.stepUpLockedUntil > new Date()) {
      throw new AppException(ErrorCodes.STEP_UP_LOCKED, 'Too many step-up attempts, try again later', 429);
    }

    const attemptsKey = stepUpKey(deviceSessionId);

    try {
      await this.verifyMethod(phone, publicKey, dto);
    } catch (err) {
      // VALIDATION_FAILED is a malformed-request rejection (missing
      // otp_request_id/challenge_id, or an unsupported method) thrown BEFORE
      // any credential is actually checked — it isn't a failed step-up attempt,
      // so it must not burn toward the lockout counter. Still rethrown as-is;
      // only the counting is skipped.
      if (err instanceof AppException && err.errorCode === ErrorCodes.VALIDATION_FAILED) {
        throw err;
      }

      // Atomic INCR+EXPIRE in one MULTI so a crash between the two can never
      // leave a TTL-less counter that locks the session out permanently — the
      // exact failure rate-limit.service.ts's INCR_WITH_TTL_LUA guards against.
      const results = await this.redis
        .multi()
        .incr(attemptsKey)
        .expire(attemptsKey, this.config.stepUpRateWindowSeconds)
        .exec();
      const count = Number(results?.[0]?.[1] ?? 0);

      if (count >= this.config.stepUpMaxAttempts) {
        const lockedUntil = new Date(
          Date.now() + this.config.stepUpRateWindowSeconds * 1000,
        );
        await this.sessionRepo.setStepUpLockedUntil(deviceSessionId, lockedUntil);
        await this.cacheInvalidator.invalidate(deviceSessionId);
      }
      throw err;
    }

    // Success — clear the attempt counter and stamp the step-up window.
    await this.redis.del(attemptsKey);
    const now        = new Date();
    const window     = dto.intendedWindowSeconds ?? this.config.stepUpValiditySeconds;
    const validUntil = new Date(now.getTime() + window * 1000);

    const dbMethod = DTO_TO_DB_STEP_UP_METHOD[dto.method];
    await this.sessionRepo.updateStepUp(deviceSessionId, dbMethod, now);
    await this.cacheInvalidator.invalidate(deviceSessionId);

    return { ok: true, method: dto.method, completedAt: now, validUntil };
  }

  private async verifyMethod(phone: string, publicKey: string, dto: StepUpDto): Promise<void> {
    switch (dto.method) {
      case 'otp_sms': {
        if (!dto.otpRequestId) throw new AppException(ErrorCodes.VALIDATION_FAILED, 'otp_request_id required', 422);
        const req = await this.otpRepo.findActiveRequest(dto.otpRequestId, phone, 'step_up');
        if (!req) throw new AppException(ErrorCodes.OTP_EXPIRED, 'OTP has expired', 422);
        // Per-phone throttle at verify time — mirrors login/signup.
        await this.rateLimit.checkPhoneOtpLimit(phone);
        await this.otpService.verifyOtp(phone, dto.credential, req);
        break;
      }
      case 'biometric': {
        if (!dto.challengeId) throw new AppException(ErrorCodes.VALIDATION_FAILED, 'challenge_id required', 422);
        await this.challenge.consumeChallenge(dto.challengeId);
        const ok = await this.crypto.verifyDeviceSignature(publicKey, dto.challengeId, dto.credential);
        if (!ok) throw new UnauthorizedError(ErrorCodes.DEVICE_SIGNATURE_INVALID, 'Device signature verification failed');
        break;
      }
      default:
        throw new AppException(ErrorCodes.VALIDATION_FAILED, 'Unsupported step-up method', 422);
    }
  }
}
