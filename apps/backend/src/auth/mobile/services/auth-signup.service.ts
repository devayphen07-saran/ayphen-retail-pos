import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '#db/db.module.js';
import { unwrapPgError } from '#db/rethrow-unique-violation.js';
import { AppException } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { UserRepository } from '../repositories/user.repository.js';
import { AuditService } from '#common/audit/audit.service.js';
import { AppConfigService } from '#config/app-config.service.js';
import { CryptoService } from '../../core/crypto.service.js';
import { RateLimitService } from '../../core/rate-limit.service.js';
import { OtpRequestService } from './otp-request.service.js';
import { OtpService } from './otp.service.js';
import { OtpRequestRepository } from '../repositories/otp-request.repository.js';
import { DeviceService, type DeviceInfo } from './device.service.js';
import { AuthSessionRepository } from '../repositories/auth-session.repository.js';
import { RefreshTokenService } from './refresh-token.service.js';
import { AccountBootstrapService } from './account-bootstrap.service.js';
import { SnapshotService } from './snapshot.service.js';
import { InvitationLookupRepository } from '../repositories/invitation-lookup.repository.js';
import type { StageOneResult, LoginResult } from '../types/auth-result.js';

@Injectable()
export class AuthSignupService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly invitationRepo: InvitationLookupRepository,
    private readonly rateLimit: RateLimitService,
    private readonly otpReqService: OtpRequestService,
    private readonly otpService: OtpService,
    private readonly otpRepo: OtpRequestRepository,
    private readonly deviceService: DeviceService,
    private readonly sessionRepo: AuthSessionRepository,
    private readonly tokenService: RefreshTokenService,
    private readonly snapshot: SnapshotService,
    private readonly crypto: CryptoService,
    private readonly config: AppConfigService,
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

    // Verify OTP FIRST — proof of phone control — BEFORE revealing whether the
    // number is registered. Checking existence first (the old order) leaked a
    // 409 vs 422 enumeration oracle to a caller with no valid OTP: a registered
    // number returned USER_ALREADY_EXISTS, an unregistered one OTP_EXPIRED. Now
    // the existence check is unreachable without solving the OTP, so a caller
    // can only probe numbers they actually control.
    const otpRequest = await this.otpRepo.findActiveRequest(
      otpRequestId,
      phone,
      'signup',
    );
    if (!otpRequest)
      throw new AppException(ErrorCodes.OTP_EXPIRED, 'OTP has expired or is no longer valid', 422);

    // Per-phone throttle at verify time — mirrors login, closes the IP-only gap.
    await this.rateLimit.checkPhoneOtpLimit(phone);

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

    // OTP proven — now safe to reveal the account already exists (tell the user
    // to log in instead). Only someone who controls the phone reaches this.
    const existing = await this.userRepo.findByPhone(phone);
    if (existing)
      throw new AppException(
        ErrorCodes.DUPLICATE_ENTRY,
        'USER_ALREADY_EXISTS',
        409,
      );

    const { user, session, refreshToken, accessToken } =
      await this.createUserAtomically(phone, name, deviceInfo, ip);

    // Best-effort, same resilience as login: a snapshot-build hiccup must not
    // fail an otherwise-successful signup. A brand-new user has never picked
    // a mode (lastAccountMode is always null), but can already have pending
    // invitations matched by phone/email from before they signed up.
    let snapshot: LoginResult['snapshot'] = null;
    let snapshotSignature: LoginResult['snapshotSignature'] = null;
    let pendingInvitationCount = 0;
    try {
      const snapshotResult = await this.snapshot.getOrBuild(user.id);
      snapshot = snapshotResult.snapshot;
      snapshotSignature = snapshotResult.signature;
      pendingInvitationCount = await this.invitationRepo.countPendingForContact(
        user.phone ?? null,
        user.email ?? null,
      );
    } catch {
      // fields stay null/0 — client falls back to its existing bootstrap call.
    }

    return {
      accessToken,
      refreshToken,
      deviceSessionId: session.id,
      snapshot,
      snapshotSignature,
      lastAccountMode: null,
      pendingInvitationCount,
      // Signup never collects an email (phone+OTP only) — always false for a
      // brand-new account, computed rather than hardcoded in case that changes.
      profileComplete: user.email !== null,
    };
  }

  /**
   * User creation + device + session + refresh token as one atomic unit.
   *
   * The `existing.length` pre-check above is TOCTOU-able by itself — two
   * concurrent signups for the same phone can both pass it before either
   * commits. The DB's unique constraint on `users.phone` is the real guard;
   * normalize its violation to the same USER_ALREADY_EXISTS shape the
   * pre-check throws, so the client sees identical text either way instead
   * of a generic "record already exists" depending on timing.
   */
  private async createUserAtomically(
    phone: string,
    name: string,
    deviceInfo: DeviceInfo,
    ip: string,
  ) {
    try {
      return await this.uow.execute(async (tx) => {
        const user = await this.userRepo.insert(
          {
            phone,
            name,
            phoneVerified: true,
            primaryLoginMethod: 'otp',
          },
          tx,
        );

        // Provision the tenant layer: account (owned by this user) + membership
        // + trialing subscription. Part of the same atomic unit as user creation.
        await this.accountBootstrap.bootstrap(user.id, tx);

        const device = await this.deviceService.upsertDevice(
          user.id,
          { ...deviceInfo, lastIp: ip },
          tx,
        );
        const session = await this.sessionRepo.create(
          {
            userFk: user.id,
            deviceFk: device.id,
            expiresAt: new Date(
              Date.now() + this.config.refreshTokenTtlSeconds * 1000,
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

        // Sign inside the tx and stamp currentJti/currentJtiExp on the same
        // session row before it commits — see auth-login.service.ts for why:
        // a session must always be blacklist-able, even before its first
        // token refresh.
        const accessToken = await this.crypto.signJwt(
          user.id,
          session.id,
          user.permissionsVersion,
        );
        const claims = this.crypto.decodeOwnJwtClaims(accessToken);
        const accessTokenExp = new Date(claims.exp * 1000);
        await this.sessionRepo.updateCurrentJti(
          session.id,
          claims.jti,
          accessTokenExp,
          tx,
        );

        // Committed in the same transaction as account creation — a
        // transient audit-write failure must roll back the signup, not
        // leave a durably-created account with no audit trail for it.
        await this.audit.logInTransaction(
          {
            event: 'SIGNUP',
            activityType: 'AUTH_SIGNUP',
            prefix: 'User',
            suffix: `signed up with phone`,
            userId: user.id,
            ipAddress: ip,
          },
          tx,
        );

        return { user, device, session, refreshToken, accessToken };
      });
    } catch (err) {
      const pgErr = unwrapPgError(err);
      // Only users.phone's own uniqueness maps to USER_ALREADY_EXISTS — the
      // same transaction can also violate account_number, refresh-token-hash,
      // or device-key-hash uniqueness, which are unrelated failures and would
      // be mislabeled by a blanket "any 23505 ⇒ already exists" check.
      if (pgErr?.code === '23505' && pgErr.constraint_name === 'users_phone_unique') {
        throw new AppException(
          ErrorCodes.DUPLICATE_ENTRY,
          'USER_ALREADY_EXISTS',
          409,
        );
      }
      throw err;
    }
  }
}
