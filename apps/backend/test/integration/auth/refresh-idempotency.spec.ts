import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { MOBILE_REDIS } from '../../../src/auth/mobile/services/redis.provider';
import { RefreshIdempotencyService } from '../../../src/auth/mobile/services/refresh-idempotency.service';
import { CryptoService } from '../../../src/auth/core/crypto.service';
import { AppConfigService } from '../../../src/config/app-config.service';
import { env } from '../../../src/config/env';

/**
 * Regression coverage for the refresh-idempotency tri-state fix (flow-critic
 * review, Finding A): a follower that gives up polling for a still-in-flight
 * leader must get a distinct `timed_out` result — never silently collapsed
 * into "proceed", which is what let a follower call `performRotation()` on a
 * token the leader hadn't finished rotating yet, tripping a false
 * `REFRESH_TOKEN_REUSE` and revoking the whole token family.
 */
describe('RefreshIdempotencyService', () => {
  let redis: Redis;
  let service: RefreshIdempotencyService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RefreshIdempotencyService,
        { provide: MOBILE_REDIS, useFactory: () => new Redis(env.REDIS_URL!) },
        {
          provide: CryptoService,
          // compile() doesn't run lifecycle hooks — derive the cache key here.
          useFactory: () => {
            const crypto = new CryptoService(new AppConfigService());
            crypto.onModuleInit();
            return crypto;
          },
        },
      ],
    }).compile();

    redis = moduleRef.get(MOBILE_REDIS);
    service = moduleRef.get(RefreshIdempotencyService);
  });

  afterAll(async () => {
    redis.disconnect();
  });

  it('the first caller for a key becomes the leader', async () => {
    const result = await service.claim(`key-${Date.now()}-a`);
    expect(result).toEqual({ role: 'leader' });
  });

  it('a second caller sees a cached "done" result once the leader completes', async () => {
    const key = `key-${Date.now()}-b`;
    const leaderClaim = await service.claim(key);
    expect(leaderClaim).toEqual({ role: 'leader' });

    await service.complete(key, { accessToken: 'fake-token' });

    const followerClaim = await service.claim(key);
    expect(followerClaim).toEqual({ role: 'cached', response: { accessToken: 'fake-token' } });
  });

  it('a follower whose leader never completes within the poll window gets `timed_out`, NOT a silent pass-through', async () => {
    const key = `key-${Date.now()}-c`;
    const leaderClaim = await service.claim(key);
    expect(leaderClaim).toEqual({ role: 'leader' });
    // Leader never calls complete() or release() — simulates a leader still
    // mid-transaction (slow DB) when the follower's poll window expires.

    const followerClaim = await service.claim(key);
    expect(followerClaim).toEqual({ role: 'timed_out' });
  }, 10_000);

  it('release() lets the next caller become a fresh leader', async () => {
    const key = `key-${Date.now()}-d`;
    await service.claim(key); // leader
    await service.release(key);

    const next = await service.claim(key);
    expect(next).toEqual({ role: 'leader' });
  });

  // ── Phase 3: split TTLs + encryption at rest ──────────────────────────────

  it('a pending claim expires within 15s — a dead leader cannot lock followers out for long', async () => {
    const key = `key-${Date.now()}-e`;
    await service.claim(key); // leader that will "die" without complete/release

    const ttl = await redis.ttl(`refresh_idem:${key}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15);
  });

  it('a done record lives ~10 minutes — the crash-recovery window for a client that lost the response', async () => {
    const key = `key-${Date.now()}-f`;
    await service.claim(key);
    await service.complete(key, { accessToken: 'fake-token' });

    const ttl = await redis.ttl(`refresh_idem:${key}`);
    expect(ttl).toBeGreaterThan(60);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it('the done record is encrypted at rest — a raw Redis read must not expose the token pair', async () => {
    const key = `key-${Date.now()}-g`;
    await service.claim(key);
    await service.complete(key, { accessToken: 'super-secret-access', refreshToken: 'super-secret-refresh' });

    const raw = await redis.get(`refresh_idem:${key}`);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain('super-secret-access');
    expect(raw).not.toContain('super-secret-refresh');

    // ...while a claim() still round-trips the plaintext response.
    const follower = await service.claim(key);
    expect(follower).toEqual({
      role: 'cached',
      response: { accessToken: 'super-secret-access', refreshToken: 'super-secret-refresh' },
    });
  });
});
