import { RefreshTokenService } from '../../../src/auth/mobile/services/refresh-token.service';
import { RefreshTokenRepository } from '../../../src/auth/mobile/repositories/refresh-token.repository';
import { ServiceUnavailableError, UnauthorizedError } from '../../../src/common/exceptions/app.exception';

/**
 * Regression coverage for `RefreshTokenService.rotate()` — pure unit tests, no
 * DB/Redis:
 *
 * 1. Finding A (flow-critic review): a `timed_out` idempotency claim must
 *    throw a distinct retryable error and NEVER fall through to
 *    `performRotation()` — falling through raced the still-in-flight leader's
 *    `markUsed` CAS and revoked the family over DB latency.
 *
 * 2. Phase 3: the cached path returns a live token pair, so it must demand
 *    the same device-binding proof as a real rotation.
 *
 * 3. Phase 3: a token whose `usedAt` is seconds old is a concurrent duplicate
 *    (retryable), not a reuse attack (family revocation).
 */

type Overrides = Partial<Record<
  'deviceRepo' | 'crypto' | 'constants' | 'blacklist' | 'challenge' |
  'tokenRepo' | 'sessionRepo' | 'cacheInvalidator' | 'idempotency' | 'snapshot' | 'uow',
  unknown
>>;

function makeService(overrides: Overrides): RefreshTokenService {
  const defaults = {
    deviceRepo:       {},
    crypto:           { hashToken: (raw: string) => `hash:${raw}` },
    constants:        {},
    blacklist:        {},
    challenge:        {},
    tokenRepo:        {},
    sessionRepo:      {},
    cacheInvalidator: {},
    idempotency:      {},
    snapshot:         {},
    uow:              {},
    ...overrides,
  };
  return new RefreshTokenService(
    defaults.deviceRepo as never,
    defaults.crypto as never,
    defaults.constants as never,
    defaults.blacklist as never,
    defaults.challenge as never,
    defaults.tokenRepo as unknown as RefreshTokenRepository,
    defaults.sessionRepo as never,
    defaults.cacheInvalidator as never,
    defaults.idempotency as never,
    defaults.snapshot as never,
    defaults.uow as never,
  );
}

const cachedResult = {
  accessToken: 'cached-access-token',
  refreshToken: 'cached-refresh-token',
  newJti: 'jti-1',
  newJtiExp: new Date('2030-01-01T00:00:00.000Z').toISOString(),
  userId: 'user-1',
  deviceSessionId: 'session-1',
  snapshotVersion: 1,
  snapshotResult: null,
};

describe('RefreshTokenService.rotate — timed_out branch', () => {
  it('throws REFRESH_IN_PROGRESS_RETRY and never calls performRotation', async () => {
    const findByHash = jest.fn(); // stands in for "performRotation was invoked"

    const service = makeService({
      tokenRepo:   { findByHash },
      idempotency: { claim: jest.fn().mockResolvedValue({ role: 'timed_out' }) },
    });

    await expect(
      service.rotate({ refreshToken: 'some-refresh-token' }),
    ).rejects.toMatchObject({
      constructor: ServiceUnavailableError,
      errorCode: 'REFRESH_IN_PROGRESS_RETRY',
    });

    // The critical assertion: performRotation's first DB call never happened.
    expect(findByHash).not.toHaveBeenCalled();
  });
});

describe('RefreshTokenService.rotate — cached branch', () => {
  it("short-circuits to the leader's stored result once device proof passes (trusted device)", async () => {
    const findByHash = jest.fn();

    const service = makeService({
      tokenRepo:   { findByHash },
      idempotency: { claim: jest.fn().mockResolvedValue({ role: 'cached', response: cachedResult }) },
      sessionRepo: { findById: jest.fn().mockResolvedValue({ id: 'session-1', deviceFk: 'device-1', revokedAt: null }) },
      deviceRepo:  { findById: jest.fn().mockResolvedValue({ id: 'device-1', isTrusted: true }) },
    });

    const result = await service.rotate({ refreshToken: 'some-refresh-token' });

    expect(result.accessToken).toBe('cached-access-token');
    expect(result.newJtiExp).toBeInstanceOf(Date);
    expect(findByHash).not.toHaveBeenCalled();
  });

  it('demands device proof for an untrusted device — a bare token replay cannot harvest the cached pair', async () => {
    const service = makeService({
      idempotency: { claim: jest.fn().mockResolvedValue({ role: 'cached', response: cachedResult }) },
      sessionRepo: { findById: jest.fn().mockResolvedValue({ id: 'session-1', deviceFk: 'device-1', revokedAt: null }) },
      deviceRepo:  { findById: jest.fn().mockResolvedValue({ id: 'device-1', isTrusted: false, publicKey: 'pk' }) },
    });

    // No challengeId / deviceSignature supplied → proof required.
    await expect(
      service.rotate({ refreshToken: 'some-refresh-token' }),
    ).rejects.toMatchObject({
      constructor: UnauthorizedError,
      errorCode: 'DEVICE_PROOF_REQUIRED',
    });
  });
});

describe('RefreshTokenService.rotate — reuse grace window (Phase 3)', () => {
  const baseRecord = {
    id: 'token-1',
    familyId: 'family-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    session: { id: 'session-1', deviceFk: 'device-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) },
    user: { id: 'user-1', deletedAt: null, status: 'active', permissionsVersion: 1 },
  };

  function repoWith(usedAt: Date) {
    return {
      findByHash:   jest.fn().mockResolvedValue({ ...baseRecord, usedAt }),
      revokeFamily: jest.fn().mockResolvedValue(undefined),
    };
  }

  const leaderIdem = () => ({
    claim:   jest.fn().mockResolvedValue({ role: 'leader' }),
    release: jest.fn().mockResolvedValue(undefined),
  });

  it('usedAt seconds ago → retryable REFRESH_IN_PROGRESS_RETRY, family NOT revoked', async () => {
    const tokenRepo = repoWith(new Date(Date.now() - 5_000));

    const service = makeService({ tokenRepo, idempotency: leaderIdem() });

    await expect(
      service.rotate({ refreshToken: 'some-refresh-token' }),
    ).rejects.toMatchObject({
      constructor: ServiceUnavailableError,
      errorCode: 'REFRESH_IN_PROGRESS_RETRY',
    });

    expect(tokenRepo.revokeFamily).not.toHaveBeenCalled();
  });

  it('usedAt beyond the grace window → genuine reuse: family revoked, REFRESH_TOKEN_REUSE', async () => {
    const tokenRepo = repoWith(new Date(Date.now() - 5 * 60_000));

    const service = makeService({ tokenRepo, idempotency: leaderIdem() });

    await expect(
      service.rotate({ refreshToken: 'some-refresh-token' }),
    ).rejects.toMatchObject({
      constructor: UnauthorizedError,
      errorCode: 'REFRESH_TOKEN_REUSE',
    });

    expect(tokenRepo.revokeFamily).toHaveBeenCalledWith('family-1', 'reuse_detected');
  });
});
