import { AuthLoginService } from '../../../src/auth/mobile/services/auth-login.service.js';
import type { UserRepository } from '../../../src/auth/mobile/repositories/user.repository.js';
import type { InvitationLookupRepository } from '../../../src/auth/mobile/repositories/invitation-lookup.repository.js';
import type { RateLimitService } from '../../../src/auth/core/rate-limit.service.js';
import type { OtpRequestService } from '../../../src/auth/mobile/services/otp-request.service.js';
import type { OtpService } from '../../../src/auth/mobile/services/otp.service.js';
import type { OtpRequestRepository } from '../../../src/auth/mobile/repositories/otp-request.repository.js';
import type { DeviceService } from '../../../src/auth/mobile/services/device.service.js';
import type { AuthSessionRepository } from '../../../src/auth/mobile/repositories/auth-session.repository.js';
import type { RefreshTokenService } from '../../../src/auth/mobile/services/refresh-token.service.js';
import type { SnapshotService } from '../../../src/auth/mobile/services/snapshot.service.js';
import type { CryptoService } from '../../../src/auth/core/crypto.service.js';
import type { AppConfigService } from '../../../src/config/app-config.service.js';
import type { AuditService } from '../../../src/common/audit/audit.service.js';
import type { UnitOfWork } from '../../../src/db/db.module.js';

const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PHONE = '9999999999';

const USER = {
  id: USER_ID,
  guuid: USER_ID,
  phone: PHONE,
  email: 'asha@example.com',
  permissionsVersion: 3,
  lastAccountMode: 'business' as const,
  accountLockedUntil: null,
  isBlocked: false,
  status: 'active',
};

/**
 * Regression coverage for the login/signup snapshot-embed resilience path
 * (backend review, §P1): `LoginResult` now carries the same routing fields
 * (snapshot, account mode, invitation count) `BootstrapResult` does, built
 * best-effort via `buildRoutingExtras`. A `SnapshotService.getOrBuild` hiccup
 * (Redis down + DB unreachable) must NOT fail an otherwise-successful login —
 * the client falls back to its existing bootstrap call when the embed is
 * absent. This is the exact invariant `loginStageTwo`'s try/catch encodes;
 * a regression here would either throw on a snapshot hiccup (failing logins
 * that don't need to) or silently embed a wrong invitation count.
 */
function makeService(getOrBuild: SnapshotService['getOrBuild']): AuthLoginService {
  const userRepo: Partial<UserRepository> = {
    findByPhone: jest.fn().mockResolvedValue(USER),
    markSuccessfulLogin: jest.fn().mockResolvedValue(undefined),
  };
  const invitationRepo: Partial<InvitationLookupRepository> = {
    countPendingForContact: jest.fn().mockResolvedValue(2),
  };
  const rateLimit: Partial<RateLimitService> = {
    checkIpLimit: jest.fn().mockResolvedValue(undefined),
    checkPhoneOtpLimit: jest.fn().mockResolvedValue(undefined),
    recordAttempt: jest.fn().mockResolvedValue(undefined),
  };
  const otpRepo: Partial<OtpRequestRepository> = {
    findActiveRequest: jest.fn().mockResolvedValue({ id: 'otp-1' }),
  };
  const otpService: Partial<OtpService> = {
    verifyOtp: jest.fn().mockResolvedValue(undefined),
  };
  const deviceService: Partial<DeviceService> = {
    upsertDevice: jest.fn().mockResolvedValue({ id: 'device-1', isTrusted: false }),
  };
  const sessionRepo: Partial<AuthSessionRepository> = {
    create: jest.fn().mockResolvedValue({ id: 'session-1' }),
    updateCurrentJti: jest.fn().mockResolvedValue(undefined),
  };
  const tokenService: Partial<RefreshTokenService> = {
    issueRefreshToken: jest.fn().mockResolvedValue('refresh-token-1'),
  };
  const snapshot: Partial<SnapshotService> = { getOrBuild };
  const crypto: Partial<CryptoService> = {
    signJwt: jest.fn().mockResolvedValue('access-token-1'),
    decodeOwnJwtClaims: jest
      .fn()
      .mockReturnValue({ jti: 'jti-1', exp: Math.floor(Date.now() / 1000) + 900 }),
  };
  const config: Partial<AppConfigService> = {
    refreshTokenTtlSeconds: 60 * 60 * 24 * 30,
  };
  const audit: Partial<AuditService> = {
    logInTransaction: jest.fn().mockResolvedValue(undefined),
  };
  // No real transaction — the callback only needs *a* tx value to pass through.
  const uow: Partial<UnitOfWork> = {
    execute: jest.fn((work: (tx: unknown) => Promise<unknown>) => work({})),
  };

  return new AuthLoginService(
    userRepo as UserRepository,
    invitationRepo as InvitationLookupRepository,
    rateLimit as RateLimitService,
    {} as OtpRequestService,
    otpService as OtpService,
    otpRepo as OtpRequestRepository,
    deviceService as DeviceService,
    sessionRepo as AuthSessionRepository,
    tokenService as RefreshTokenService,
    snapshot as SnapshotService,
    {} as never,
    {} as never,
    crypto as CryptoService,
    config as AppConfigService,
    audit as AuditService,
    uow as UnitOfWork,
  );
}

describe('AuthLoginService.loginStageTwo — snapshot-embed resilience', () => {
  it('embeds the fresh snapshot + routing fields when SnapshotService succeeds', async () => {
    const service = makeService(
      jest.fn().mockResolvedValue({
        snapshot: { userId: USER_ID, permissionsVersion: 3, generatedAt: 'now', stores: [] },
        signature: 'sig-1',
      }),
    );

    const result = await service.loginStageTwo(
      PHONE,
      '123456',
      'otp-request-1',
      { platform: 'ios', appVersion: '1.0.0', publicKey: 'pk' },
      '127.0.0.1',
    );

    expect(result.snapshot).not.toBeNull();
    expect(result.snapshotSignature).toBe('sig-1');
    expect(result.lastAccountMode).toBe('business');
    expect(result.pendingInvitationCount).toBe(2);
  });

  it('returns a valid login result with null snapshot fields when SnapshotService throws, instead of failing the login', async () => {
    const service = makeService(jest.fn().mockRejectedValue(new Error('redis + db both down')));

    const result = await service.loginStageTwo(
      PHONE,
      '123456',
      'otp-request-1',
      { platform: 'ios', appVersion: '1.0.0', publicKey: 'pk' },
      '127.0.0.1',
    );

    // The login itself must still succeed — tokens are real, session is real.
    expect(result.accessToken).toBe('access-token-1');
    expect(result.refreshToken).toBe('refresh-token-1');
    expect(result.deviceSessionId).toBe('session-1');

    // The embed failed, so both snapshot fields must be null — the client's
    // fallback to a full bootstrap call is keyed off exactly this.
    expect(result.snapshot).toBeNull();
    expect(result.snapshotSignature).toBeNull();

    // lastAccountMode still comes through correctly: it's read from the
    // already-fetched `user` object, not from the failed snapshot build.
    expect(result.lastAccountMode).toBe('business');

    // pendingInvitationCount falls back to 0 rather than a stale/wrong
    // value — buildRoutingExtras never reaches the invitation-count query
    // once getOrBuild has thrown (they're sequenced, not parallel).
    expect(result.pendingInvitationCount).toBe(0);
  });
});
