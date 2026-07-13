import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { UnitOfWork, type DbTransaction } from '#db/db.module.js';
import { unwrapPgError } from '#db/rethrow-unique-violation.js';
import { AppException, ConflictError, NotFoundError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { AuditService } from '#common/audit/audit.service.js';
import { AppConfigService } from '#config/app-config.service.js';
import { CryptoService } from '../../core/crypto.service.js';
import { RateLimitService } from '../../core/rate-limit.service.js';
import { OtpRequestService } from './otp-request.service.js';
import { OtpService } from './otp.service.js';
import { OtpRequestRepository } from '../repositories/otp-request.repository.js';
import { UserRepository, type User } from '../repositories/user.repository.js';
import { InvitationLookupRepository } from '../repositories/invitation-lookup.repository.js';
import { DeviceService, type DeviceInfo } from './device.service.js';
import { AuthSessionRepository, type DeviceSession } from '../repositories/auth-session.repository.js';
import { RefreshTokenService } from './refresh-token.service.js';
import { SnapshotService } from './snapshot.service.js';
import { PrincipalCacheService } from './principal-cache.service.js';
import { AuthLogoutService } from './auth-logout.service.js';
import type {
  StageOneResult,
  LoginResult,
  BootstrapResult,
  ProfileResult,
} from '../types/auth-result.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import type { PermissionSnapshot } from '#common/types/permission-snapshot.js';

interface RoutingExtras {
  snapshot: PermissionSnapshot;
  snapshotSignature: string;
  lastAccountMode: 'business' | 'personal' | null;
  pendingInvitationCount: number;
}

/** The routing/display fields of a LoginResult, assembled after token issuance. */
type LoginExtras = Pick<
  LoginResult,
  'snapshot' | 'snapshotSignature' | 'lastAccountMode' | 'pendingInvitationCount' | 'profileComplete'
>;

@Injectable()
export class AuthLoginService {
  private readonly logger = new Logger(AuthLoginService.name);

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
    private readonly principalCache: PrincipalCacheService,
    private readonly authLogout: AuthLogoutService,
    private readonly crypto: CryptoService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly uow: UnitOfWork,
  ) {}

  /** Stage 1 — request an OTP for login. */
  async loginStageOne(
    phone: string,
    ip: string,
    resendOf?: string,
  ): Promise<StageOneResult> {
    const user = await this.userRepo.findByPhone(phone);
    if (!user) {
      // Uniform response — never reveal whether a number is registered
      // (enumeration oracle). No OTP is sent; a follow-up verify fails as
      // OTP_EXPIRED, identical to a genuine lapsed request. Still rate-limited
      // identically to a registered number (mirrors signupStageOne) — otherwise
      // an attacker could probe unregistered numbers without ever hitting a
      // throttle, since requestOtp()'s checks are skipped on this branch.
      await this.rateLimit.checkIpLimit(ip);
      await this.rateLimit.checkPhoneOtpLimit(phone);
      return {
        otpSent: true,
        expiresIn: this.config.otpTtlSeconds,
        otpRequestId: randomUUID(),
      };
    }

    const result = await this.otpReqService.requestOtp(
      phone,
      'login',
      ip,
      resendOf,
    );
    return {
      otpSent: true,
      expiresIn: result.expiresIn,
      otpRequestId: result.otpRequestId,
    };
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
    const result = await this.otpReqService.requestOtp(
      user.phone,
      'step_up',
      ip,
    );
    return {
      otpSent: true,
      expiresIn: result.expiresIn,
      otpRequestId: result.otpRequestId,
    };
  }

  /** Stage 2 — verify the OTP, then issue tokens inside a single transaction. */
  async loginStageTwo(
    phone: string,
    otpCode: string,
    otpRequestId: string,
    deviceInfo: DeviceInfo,
    ip: string,
  ): Promise<LoginResult> {
    await this.rateLimit.checkIpLimit(ip);

    const otpRequest = await this.otpRepo.findActiveRequest(
      otpRequestId,
      phone,
      'login',
    );
    if (!otpRequest)
      throw new AppException(ErrorCodes.OTP_EXPIRED, 'OTP has expired or is no longer valid', 422);

    const user = await this.userRepo.findByPhone(phone);
    if (!user) {
      // Uniform with a lapsed request — never reveal "no account exists here"
      // as a distinct signal (enumeration oracle). Combined with the fake
      // otpRequestId loginStageOne returns for unregistered numbers (no OTP
      // row is ever minted for them), this branch is only reachable in the
      // narrow race where the user was deleted between stage one and two.
      throw new AppException(ErrorCodes.OTP_EXPIRED, 'OTP has expired or is no longer valid', 422);
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
      throw new AppException(
        ErrorCodes.USER_BLOCKED,
        'This account has been blocked',
        403,
      );
    }
    if (user.status === 'suspended') {
      throw new AppException(
        ErrorCodes.USER_SUSPENDED,
        'This account has been suspended',
        403,
      );
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
      await this.rateLimit.recordAttempt({
        ip,
        phone,
        purpose: 'login',
        success: false,
      });
      throw err;
    }

    // All writes commit together or roll back together — no orphan device/session.
    const { session, refreshToken, accessToken } = await this.uow.execute((tx) =>
      this.issueSessionTokens(user, deviceInfo, ip, tx),
    );

    await this.rateLimit.recordAttempt({
      ip,
      phone,
      purpose: 'login',
      success: true,
    });

    return {
      accessToken,
      refreshToken,
      deviceSessionId: session.id,
      ...(await this.assembleLoginExtras(user)),
    };
  }

  /**
   * Issue a session + tokens for a verified login, all inside one transaction so
   * a mid-flight failure leaves no orphan device/session (mirrors signup's
   * createUserAtomically). Signing runs mid-transaction — it's pure crypto, no
   * DB round trip — so the session row commits already blacklist-able.
   */
  private async issueSessionTokens(
    user: User,
    deviceInfo: DeviceInfo,
    ip: string,
    tx: DbTransaction,
  ): Promise<{ session: DeviceSession; refreshToken: string; accessToken: string }> {
    await this.userRepo.markSuccessfulLogin(user.id, tx);

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
        pushToken: deviceInfo.pushToken,
      },
      tx,
    );

    const refreshToken = await this.tokenService.issueRefreshToken(session.id, tx);

    // Sign inside the tx and stamp currentJti/currentJtiExp on the same session
    // row before it commits — a session must always be blacklist-able. Without
    // this, revokeSession()/logoutAll() gate the blacklist write on currentJti
    // being non-null, so a stolen device revoked before its first token refresh
    // would keep a fully valid access token until natural expiry.
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

    // Committed in the same transaction as the effect it records — a transient
    // audit-write failure must roll back the login, not leave a durably-issued
    // session with no audit trail for it.
    await this.audit.logInTransaction(
      {
        event: 'LOGIN_SUCCESS',
        activityType: 'AUTH_LOGIN',
        prefix: 'User',
        suffix: `logged in from ${ip}`,
        userId: user.id,
        ipAddress: ip,
        metadata: { platform: deviceInfo.platform },
      },
      tx,
    );

    return { session, refreshToken, accessToken };
  }

  /**
   * Assemble the routing/display fields that ride along with a login response.
   * `profileComplete` derives straight off the already-loaded user row so it's
   * always accurate; the snapshot embed is best-effort — a build hiccup must not
   * fail an otherwise-successful login, so on failure the client sees null
   * snapshot fields and falls back to its existing bootstrap call.
   */
  private async assembleLoginExtras(user: User): Promise<LoginExtras> {
    const profileComplete = user.email !== null;
    try {
      const built = await this.buildRoutingExtras(user.id, {
        phone: user.phone ?? null,
        email: user.email ?? null,
        lastAccountMode: user.lastAccountMode ?? null,
      });
      return {
        snapshot: built.snapshot,
        snapshotSignature: built.snapshotSignature,
        lastAccountMode: built.lastAccountMode,
        pendingInvitationCount: built.pendingInvitationCount,
        profileComplete,
      };
    } catch {
      return {
        snapshot: null,
        snapshotSignature: null,
        lastAccountMode: user.lastAccountMode ?? null,
        pendingInvitationCount: 0,
        profileComplete,
      };
    }
  }

  /** Display data for the profile screen — NOT part of login/bootstrap's
   *  routing payload (see ProfileResult's doc comment): fetched only when
   *  that screen is actually opened, always fresh at that point. */
  async getProfile(userId: string): Promise<ProfileResult> {
    const profile = await this.userRepo.findProfile(userId);
    if (!profile) {
      throw new NotFoundError(ErrorCodes.USER_NOT_FOUND, 'User not found');
    }
    return profile;
  }

  /**
   * Complete-your-profile / edit-profile write path (currently name/email
   * only — phone is the login credential and changing it needs its own
   * OTP-reverification flow, not a plain PATCH). Email is normalized
   * lowercase/trimmed by the request DTO before it reaches here, so the
   * `users.email` unique index is the sole source of truth for "taken".
   */
  async updateProfile(
    userId: string,
    patch: { name?: string; email?: string },
  ): Promise<ProfileResult> {
    try {
      await this.userRepo.updateProfile(userId, patch);
    } catch (err) {
      if (unwrapPgError(err)?.code === '23505') {
        throw new ConflictError(
          ErrorCodes.DUPLICATE_ENTRY,
          'This email is already in use',
        );
      }
      throw err;
    }
    const profile = await this.userRepo.findProfile(userId);
    if (!profile) {
      throw new AppException(ErrorCodes.USER_NOT_FOUND, 'USER_NOT_FOUND', 404);
    }
    return profile;
  }

  /** Full session snapshot for an already-authenticated principal — what a
   *  cold-launch refresh (tokens only) is missing relative to a fresh login. */
  async bootstrap(principal: MobilePrincipal): Promise<BootstrapResult> {
    const user = await this.userRepo.findById(principal.userId);
    const extras = await this.buildRoutingExtras(principal.userId, {
      phone: user?.phone ?? null,
      email: user?.email ?? null,
      lastAccountMode: user?.lastAccountMode ?? null,
    });

    return {
      deviceSessionId: principal.deviceSessionId,
      profileComplete: (user?.email ?? null) !== null,
      ...extras,
    };
  }

  /** Snapshot + account-mode + pending-invitation-count — the routing data a
   *  fresh login/signup and a cold-launch bootstrap both need. No clientVersion
   *  is passed to `getOrBuild`, so the snapshot is always built (never the
   *  "client is up to date" null case). */
  private async buildRoutingExtras(
    userId: string,
    contact: {
      phone: string | null;
      email: string | null;
      lastAccountMode: 'business' | 'personal' | null;
    },
  ): Promise<RoutingExtras> {
    const snapshotResult = await this.snapshot.getOrBuild(userId);
    const pendingInvitationCount =
      await this.invitationRepo.countPendingForContact(
        contact.phone,
        contact.email,
      );

    return {
      snapshot: snapshotResult.snapshot,
      snapshotSignature: snapshotResult.signature,
      lastAccountMode: contact.lastAccountMode,
      pendingInvitationCount,
    };
  }

  /** Set the user's chosen workspace mode (mobile-03 §3c/3d). */
  async updateAccountMode(
    userId: string,
    mode: 'business' | 'personal',
  ): Promise<void> {
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
        new Date(
          Date.now() + this.config.accountLockoutDurationMinutes * 60_000,
        ),
      );
      // The lockout write above is durable; everything below is best-effort
      // immediate enforcement so the lockout doesn't just sit in the DB until
      // caches/sessions happen to expire on their own TTL. A failure here must
      // not turn an already-decided "too many failed attempts" response into a
      // 500 — logoutAll() reuses the exact same session/token/blacklist
      // machinery DeviceAccessService.blockDevice() uses for the equivalent
      // "kill access now" guarantee.
      try {
        await this.principalCache.invalidateUser(userId);
        await this.authLogout.logoutAll(userId);
      } catch (err) {
        this.logger.warn(
          `Failed to fully enforce lockout for user ${userId} — the lockout itself is` +
            ` durable, but existing sessions may remain live until their own TTL: ${
              err instanceof Error ? err.message : String(err)
            }`,
        );
      }
    }
  }
}
