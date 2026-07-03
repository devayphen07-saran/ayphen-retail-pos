import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, UnitOfWork, type DbExecutor } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { users, invitations } from '#db/schema.js';
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
import { SnapshotService } from './snapshot.service.js';
import type { StageOneResult, LoginResult, BootstrapResult } from '../types/auth-result.js';
import type { MobilePrincipal } from '../types/mobile-principal.js';

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
    private readonly snapshot:      SnapshotService,
    private readonly crypto:        CryptoService,
    private readonly constants:     AuthConstantsService,
    private readonly audit:         AuditService,
    private readonly uow:           UnitOfWork,
  ) {}

  /** Stage 1 — request an OTP for login. */
  async loginStageOne(phone: string, ip: string, resendOf?: string): Promise<StageOneResult> {
    const [user] = await this.db.select({ id: users.id }).from(users).where(eq(users.phone, phone));
    if (!user) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'No account is registered with this number. Create an account to get started.',
        401,
      );
    }

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
    if (!user) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'No account is registered with this number. Create an account to get started.',
        401,
      );
    }

    if (user.accountLockedUntil && user.accountLockedUntil > new Date()) {
      throw new AppException(
        ErrorCodes.ACCOUNT_LOCKED,
        'Account temporarily locked due to too many failed attempts',
        429,
      );
    }

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
      user:            { id: user.guuid, permissionsVersion: user.permissionsVersion },
      isNewUser:       false,
      deviceId:        device.id,
      deviceSessionId: session.id,
      isTrusted:       device.isTrusted,
    };
  }

  /** Full session snapshot for an already-authenticated principal — lets a
   *  cold-launch refresh (tokens only) populate the same session state a
   *  fresh login gets for free from `LoginResponse.user`. */
  async bootstrap(principal: MobilePrincipal): Promise<BootstrapResult> {
    const device = await this.deviceService.findById(principal.deviceId);

    // No clientVersion — a cold-launch restore has nothing cached, so the
    // snapshot is always built (never the "client is up to date" null case).
    const snapshotResult = await this.snapshot.getOrBuild(principal.userId);

    const [user] = await this.db
      .select({ phone: users.phone, email: users.email, lastAccountMode: users.lastAccountMode })
      .from(users)
      .where(eq(users.id, principal.userId));

    const pendingInvitationCount = await this.countPendingInvitations(
      user?.phone ?? null,
      user?.email ?? null,
    );

    return {
      user:               { id: principal.userGuuid, permissionsVersion: principal.permissionsVersion },
      deviceId:           principal.deviceId,
      deviceSessionId:    principal.deviceSessionId,
      isTrusted:          device?.isTrusted ?? false,
      snapshot:           snapshotResult!.snapshot,
      snapshotSignature:  snapshotResult!.signature,
      lastAccountMode:    user?.lastAccountMode ?? null,
      hasPendingInvitations: pendingInvitationCount > 0,
      pendingInvitationCount,
    };
  }

  /** Set the user's chosen workspace mode (mobile-03 §3c/3d). */
  async updateAccountMode(userId: string, mode: 'business' | 'personal'): Promise<void> {
    await this.db.update(users).set({ lastAccountMode: mode }).where(eq(users.id, userId));
  }

  /**
   * Invitations aren't keyed by userFk (the invitee may not have an account
   * yet at invite time) — matched by phone/email instead, same lookup
   * `GET /me/invitations` uses (invitation.repository.ts's
   * `listPendingForContact`, duplicated here to avoid a cross-module
   * dependency on the stores module from auth/mobile).
   */
  private async countPendingInvitations(phone: string | null, email: string | null): Promise<number> {
    if (!phone && !email) return 0;

    const contactMatch = [];
    if (phone) contactMatch.push(eq(invitations.phone, phone));
    if (email) contactMatch.push(eq(invitations.email, email));

    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(invitations)
      .where(
        and(
          eq(invitations.status, 'pending'),
          gt(invitations.expiresAt, new Date()),
          or(...contactMatch),
        ),
      );

    return row?.n ?? 0;
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
