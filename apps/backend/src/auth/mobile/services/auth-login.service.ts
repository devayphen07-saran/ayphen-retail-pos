import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { UnitOfWork, type DbExecutor } from '#db/db.module.js';
import { AppException } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { AuditService } from '#common/audit/audit.service.js';
import { AppConfigService } from '#config/app-config.service.js';
import { CryptoService } from '../../core/crypto.service.js';
import { RateLimitService } from '../../core/rate-limit.service.js';
import { OtpRequestService } from './otp-request.service.js';
import { OtpService } from './otp.service.js';
import { OtpRequestRepository } from '../repositories/otp-request.repository.js';
import { UserRepository } from '../repositories/user.repository.js';
import { InvitationLookupRepository } from '../repositories/invitation-lookup.repository.js';
import { DeviceService, type DeviceInfo } from './device.service.js';
import { AuthSessionRepository } from '../repositories/auth-session.repository.js';
import { RefreshTokenService } from './refresh-token.service.js';
import { SnapshotService } from './snapshot.service.js';
import type { StageOneResult, LoginResult, BootstrapResult } from '../types/auth-result.js';
import type { MobilePrincipal } from '#common/types/principal.js';

@Injectable()
export class AuthLoginService {
  constructor(
    private readonly userRepo:      UserRepository,
    private readonly invitationRepo: InvitationLookupRepository,
    private readonly rateLimit:     RateLimitService,
    private readonly otpReqService: OtpRequestService,
    private readonly otpService:    OtpService,
    private readonly otpRepo:       OtpRequestRepository,
    private readonly deviceService: DeviceService,
    private readonly sessionRepo:   AuthSessionRepository,
    private readonly tokenService:  RefreshTokenService,
    private readonly snapshot:      SnapshotService,
    private readonly crypto:        CryptoService,
    private readonly config:        AppConfigService,
    private readonly audit:         AuditService,
    private readonly uow:           UnitOfWork,
  ) {}

  /** Stage 1 — request an OTP for login. */
  async loginStageOne(phone: string, ip: string, resendOf?: string): Promise<StageOneResult> {
    const user = await this.userRepo.findByPhone(phone);
    if (!user) {
      // Uniform response — never reveal whether a number is registered
      // (enumeration oracle). No OTP is sent; a follow-up verify fails as
      // OTP_EXPIRED, identical to a genuine lapsed request.
      return {
        otpSent: true,
        expiresIn: this.config.otpTtlSeconds,
        otpRequestId: randomUUID(),
      };
    }

    const result = await this.otpReqService.requestOtp(phone, 'login', ip, resendOf);
    return { otpSent: true, expiresIn: result.expiresIn, otpRequestId: result.otpRequestId };
  }

  /**
   * Stage 1 for step-up — the OTP ALWAYS targets the authenticated user's own
   * registered phone, never a client-supplied number. Prevents an authenticated
   * user from triggering OTP SMS to arbitrary phones (SMS-bombing / enumeration).
   */
  async stepUpStageOne(userId: string, ip: string): Promise<StageOneResult> {
    const user = await this.userRepo.findById(userId);
    if (!user?.phone) {
      throw new AppException(ErrorCodes.USER_NOT_FOUND, 'USER_NOT_FOUND', 404);
    }
    // Mint with the `step_up` purpose (not `login`) so a step-up OTP can't be
    // replayed against login/verify and vice-versa — step-up verify scopes to
    // the same purpose.
    const result = await this.otpReqService.requestOtp(user.phone, 'step_up', ip);
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

    const otpRequest = await this.otpRepo.findActiveRequest(otpRequestId, phone, 'login');
    if (!otpRequest) throw new AppException(ErrorCodes.TOKEN_EXPIRED, 'OTP_EXPIRED', 422);

    const user = await this.userRepo.findByPhone(phone);
    if (!user) {
      // Uniform with a lapsed request — never reveal "no account exists here"
      // as a distinct signal (enumeration oracle). Combined with the fake
      // otpRequestId loginStageOne returns for unregistered numbers (no OTP
      // row is ever minted for them), this branch is only reachable in the
      // narrow race where the user was deleted between stage one and two.
      throw new AppException(ErrorCodes.TOKEN_EXPIRED, 'OTP_EXPIRED', 422);
    }

    if (user.accountLockedUntil && user.accountLockedUntil > new Date()) {
      throw new AppException(
        ErrorCodes.ACCOUNT_LOCKED,
        'Account temporarily locked due to too many failed attempts',
        429,
      );
    }

    // Admin-applied blocks must reject login outright — a valid OTP proves
    // phone possession, not that the block should lift. Deliberately NOT
    // checking status==='locked' here: that's the failed-attempts lockout
    // already covered by accountLockedUntil above, and a successful login is
    // exactly how it's meant to clear (see markSuccessfulLogin).
    if (user.isBlocked) {
      throw new AppException(ErrorCodes.USER_BLOCKED, 'This account has been blocked', 403);
    }
    if (user.status === 'suspended') {
      throw new AppException(ErrorCodes.USER_SUSPENDED, 'This account has been suspended', 403);
    }

    // Per-phone throttle at verify time, not just at OTP-request time — closes
    // the gap where verify was rate-limited by IP only, so an attacker
    // spreading requests across IPs faced no phone-scoped limit at all.
    await this.rateLimit.checkPhoneOtpLimit(phone);

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
        expiresAt:    new Date(Date.now() + this.config.refreshTokenTtlSeconds * 1000),
        ipAtCreation: ip,
        appVersion:   deviceInfo.appVersion,
        platform:     deviceInfo.platform,
        pushToken:    deviceInfo.pushToken,
      }, tx);

      const refreshToken = await this.tokenService.issueRefreshToken(session.id, tx);

      // Committed in the same transaction as the effect it records — a
      // transient audit-write failure must roll back the login, not leave a
      // durably-issued session with no audit trail for it.
      await this.audit.logInTransaction({
        event:        'LOGIN_SUCCESS',
        activityType: 'AUTH_LOGIN',
        prefix:       'User',
        suffix:       `logged in from ${ip}`,
        userId:       user.id,
        ipAddress:    ip,
        metadata:     { platform: deviceInfo.platform },
      }, tx);

      return { device, session, refreshToken };
    });

    // Post-transaction: token signing + external side effects.
    const accessToken = await this.crypto.signJwt(user.id, session.id, user.permissionsVersion);

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

    const user = await this.userRepo.findById(principal.userId);

    const pendingInvitationCount = await this.invitationRepo.countPendingForContact(
      user?.phone ?? null,
      user?.email ?? null,
    );

    return {
      user:               { id: principal.userGuuid, permissionsVersion: principal.permissionsVersion },
      deviceId:           principal.deviceId,
      deviceSessionId:    principal.deviceSessionId,
      isTrusted:          device?.isTrusted ?? false,
      snapshot:           snapshotResult.snapshot,
      snapshotSignature:  snapshotResult.signature,
      lastAccountMode:    user?.lastAccountMode ?? null,
      hasPendingInvitations: pendingInvitationCount > 0,
      pendingInvitationCount,
    };
  }

  /** Set the user's chosen workspace mode (mobile-03 §3c/3d). */
  async updateAccountMode(userId: string, mode: 'business' | 'personal'): Promise<void> {
    await this.userRepo.setAccountMode(userId, mode);
  }

  // ── HELPERS (§18.4) ───────────────────────────────────────────────────────

  private async handleFailedOtp(userId: string): Promise<void> {
    // Atomic increment returns the fresh count (concurrent failures can't lose
    // an increment); if it crosses the threshold, apply the lockout.
    const attempts = await this.userRepo.incrementFailedAttempts(userId);
    if (attempts >= this.config.maxFailedLoginAttempts) {
      await this.userRepo.applyLockout(
        userId,
        new Date(Date.now() + this.config.accountLockoutDurationMinutes * 60_000),
      );
    }
  }

  private async handleSuccessfulLogin(userId: string, tx?: DbExecutor): Promise<void> {
    await this.userRepo.markSuccessfulLogin(userId, tx);
  }
}
