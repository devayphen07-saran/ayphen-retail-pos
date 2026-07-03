import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, UnitOfWork } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { users } from '#db/schema.js';
import { AppException } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
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
import { AccountBootstrapService } from './account-bootstrap.service.js';
import type { StageOneResult, LoginResult } from '../types/auth-result.js';

@Injectable()
export class AuthSignupService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly rateLimit: RateLimitService,
    private readonly otpReqService: OtpRequestService,
    private readonly otpService: OtpService,
    private readonly otpRepo: OtpRequestRepository,
    private readonly deviceService: DeviceService,
    private readonly sessionRepo: AuthSessionRepository,
    private readonly tokenService: RefreshTokenService,
    private readonly crypto: CryptoService,
    private readonly constants: AuthConstantsService,
    private readonly audit: AuditService,
    private readonly accountBootstrap: AccountBootstrapService,
    private readonly uow: UnitOfWork,
  ) {}

  /** Stage 1 — request an OTP for signup. */
  async signupStageOne(phone: string, ip: string): Promise<StageOneResult> {
    const result = await this.otpReqService.requestOtp(phone, 'signup', ip);
    return {
      otpSent: true,
      expiresIn: result.expiresIn,
      otpRequestId: result.otpRequestId,
    };
  }

  /** Stage 2 — verify OTP, then create user + device + session atomically. */
  async signupStageTwo(
    phone: string,
    otpCode: string,
    otpRequestId: string,
    name: string,
    deviceInfo: DeviceInfo,
    ip: string,
  ): Promise<LoginResult> {
    await this.rateLimit.checkIpLimit(ip);

    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, phone));
    if (existing.length)
      throw new AppException(
        ErrorCodes.DUPLICATE_ENTRY,
        'USER_ALREADY_EXISTS',
        409,
      );

    const otpRequest = await this.otpRepo.findActiveRequest(
      otpRequestId,
      phone,
    );
    if (!otpRequest)
      throw new AppException(ErrorCodes.TOKEN_EXPIRED, 'OTP_EXPIRED', 422);
    try {
      await this.otpService.verifyOtp(phone, otpCode, otpRequest);
    } catch (err) {
      await this.rateLimit.recordAttempt({
        ip,
        phone,
        purpose: 'signup',
        success: false,
      });
      throw err;
    }

    // User creation + device + session + refresh token are one atomic unit.
    const { user, device, session, refreshToken } = await this.uow.execute(
      async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({
            phone,
            name,
            phoneVerified: true,
            primaryLoginMethod: 'otp',
          })
          .returning();

        // Provision the tenant layer: account (owned by this user) + membership
        // + trialing subscription. Part of the same atomic unit as user creation.
        await this.accountBootstrap.bootstrap(user!.id, tx);

        const device = await this.deviceService.upsertDevice(
          user!.id,
          { ...deviceInfo, lastIp: ip },
          tx,
        );
        const session = await this.sessionRepo.create(
          {
            userFk: user!.id,
            deviceFk: device.id,
            expiresAt: new Date(
              Date.now() + this.constants.REFRESH_TOKEN_TTL_SECONDS * 1000,
            ),
            ipAtCreation: ip,
            appVersion: deviceInfo.appVersion,
            platform: deviceInfo.platform,
          },
          tx,
        );

        const refreshToken = await this.tokenService.issueRefreshToken(
          session.id,
          tx,
        );
        return { user: user!, device, session, refreshToken };
      },
    );

    const accessToken = await this.crypto.signJwt(user.id, session.id, user.permissionsVersion);

    await this.audit.log({
      event: 'SIGNUP',
      activityType: 'AUTH_SIGNUP',
      prefix: 'User',
      suffix: `signed up with phone`,
      userId: user.id,
      ipAddress: ip,
    });

    return {
      accessToken,
      refreshToken,
      user: { id: user.guuid, permissionsVersion: user.permissionsVersion },
      isNewUser: true,
      deviceId: device.id,
      deviceSessionId: session.id,
      isTrusted: device.isTrusted,
    };
  }
}
