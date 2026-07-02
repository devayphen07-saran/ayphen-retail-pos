import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, UnitOfWork, type DbExecutor } from '../../../db/db.module.js';
import * as schema from '../../../db/schema.js';
import { users } from '../../../db/schema.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import { ErrorCodes } from '../../../common/error-codes.js';
import { AuditService } from '../../core/audit.service.js';
import { AuthConstantsService } from '../../core/auth-constants.service.js';
import { CryptoService } from '../../core/crypto.service.js';
import { RateLimitService } from '../../core/rate-limit.service.js';
import { OtpRequestService } from './otp-request.service.js';
import { OtpService } from './otp.service.js';
import { OtpRequestRepository } from '../repositories/otp-request.repository.js';
import { DeviceService, type DeviceInfo } from './device.service.js';
import { AuthSessionRepository } from '../repositories/auth-session.repository.js';
import { RefreshTokenService } from './refresh-token.service.js';
import type { StageOneResult, LoginResult } from '../types/auth-result.js';

@Injectable()
export class AuthLoginService {
  constructor(
    @Inject(DRIZZLE)          private readonly db:          PostgresJsDatabase<typeof schema>,
    private readonly rateLimit:     RateLimitService,
    private readonly otpReqService: OtpRequestService,
    private readonly otpService:    OtpService,
    private readonly otpRepo:       OtpRequestRepository,
    private readonly deviceService: DeviceService,
    private readonly sessionRepo:   AuthSessionRepository,
    private readonly tokenService:  RefreshTokenService,
    private readonly crypto:        CryptoService,
    private readonly constants:     AuthConstantsService,
    private readonly audit:         AuditService,
    private readonly uow:           UnitOfWork,
  ) {}

  /** Stage 1 — request an OTP for login. */
  async loginStageOne(phone: string, ip: string, resendOf?: string): Promise<StageOneResult> {
    const result = await this.otpReqService.requestOtp(phone, 'login', ip, resendOf);
    return { otpSent: true, expiresIn: result.expiresIn, otpRequestId: result.otpRequestId };
  }

  /** Stage 2 — verify the OTP, then issue tokens inside a single transaction. */
  async loginStageTwo(
    phone:        string,
    otpCode:      string,
    otpRequestId: string,
    deviceInfo:   DeviceInfo,
    ip:           string,
  ): Promise<LoginResult> {
    await this.rateLimit.checkIpLimit(ip);

    const otpRequest = await this.otpRepo.findActiveRequest(otpRequestId, phone);
    if (!otpRequest) throw new AppException(ErrorCodes.TOKEN_EXPIRED, 'OTP_EXPIRED', 422);

    const [user] = await this.db.select().from(users).where(eq(users.phone, phone));
    if (!user) throw new AppException(ErrorCodes.NOT_FOUND, 'USER_NOT_FOUND', 401);

    try {
      await this.otpService.verifyOtp(phone, otpCode, otpRequest);
    } catch (err) {
      await this.handleFailedOtp(user.id);
      // Record the failed attempt so it counts toward IP/phone throttling —
      // matches auth-signup.service.ts, which records failures symmetrically.
      await this.rateLimit.recordAttempt({ ip, phone, purpose: 'login', success: false });
      throw err;
    }

    // All writes commit together or roll back together — no orphan device/session.
    const { device, session, refreshToken } = await this.uow.execute(async (tx) => {
      await this.handleSuccessfulLogin(user.id, tx);

      const device  = await this.deviceService.upsertDevice(user.id, { ...deviceInfo, lastIp: ip }, tx);
      const session = await this.sessionRepo.create({
        userFk:       user.id,
        deviceFk:     device.id,
        expiresAt:    new Date(Date.now() + this.constants.REFRESH_TOKEN_TTL_SECONDS * 1000),
        ipAtCreation: ip,
        appVersion:   deviceInfo.appVersion,
        platform:     deviceInfo.platform,
        pushToken:    deviceInfo.pushToken,
      }, tx);

      const refreshToken = await this.tokenService.issueRefreshToken(session.id, tx);
      return { device, session, refreshToken };
    });

    // Post-transaction: token signing + external side effects.
    const accessToken = await this.crypto.signJwt(user.id, session.id, user.permissionsVersion);

    await this.audit.log({
      event:        'LOGIN_SUCCESS',
      activityType: 'AUTH_LOGIN',
      prefix:       'User',
      suffix:       `logged in from ${ip}`,
      userId:       user.id,
      ipAddress:    ip,
      metadata:     { platform: deviceInfo.platform },
    });

    await this.rateLimit.recordAttempt({ ip, phone, purpose: 'login', success: true });

    return {
      accessToken,
      refreshToken,
      user:               { id: user.guuid, permissionsVersion: user.permissionsVersion },
      isNewUser:          false,
      deviceGuuid:        device.id,
      deviceSessionGuuid: session.id,
      isTrusted:          device.isTrusted,
    };
  }

  // ── HELPERS (§18.4) ───────────────────────────────────────────────────────

  private async handleFailedOtp(userId: string): Promise<void> {
    // Atomic read-modify-write: increment in the DB (`failedLoginAttempts + 1`)
    // and RETURN the new value, so concurrent failed attempts can't lose an
    // increment (a plain read-then-.set() would). Then, if the fresh count
    // crosses the threshold, apply the lockout in a second targeted update.
    const [row] = await this.db
      .update(users)
      .set({ failedLoginAttempts: sql`${users.failedLoginAttempts} + 1` })
      .where(eq(users.id, userId))
      .returning({ attempts: users.failedLoginAttempts });

    const attempts = row?.attempts ?? 0;
    if (attempts >= this.constants.MAX_FAILED_LOGIN_ATTEMPTS) {
      await this.db
        .update(users)
        .set({
          accountLockedUntil: new Date(
            Date.now() + this.constants.ACCOUNT_LOCKOUT_DURATION_MINUTES * 60_000,
          ),
          status: 'locked',
        })
        .where(eq(users.id, userId));
    }
  }

  private async handleSuccessfulLogin(userId: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db).update(users).set({
      failedLoginAttempts: 0,
      accountLockedUntil:  null,
      status:              'active',
      lastLoginAt:         new Date(),
      phoneVerified:       true,    // §18.9 — set on successful OTP
    }).where(eq(users.id, userId));
  }
}
