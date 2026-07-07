import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import Redis from 'ioredis';
import { env } from '../../../src/config/env';
import { SyncRateLimitGuard, SyncRateLimit } from '../../../src/sync/guards/sync-rate-limit.guard';

class FakeController {
  @SyncRateLimit('changes')
  changes(): void {}

  @SyncRateLimit('delta')
  delta(): void {}

  undecorated(): void {}
}

function fakeContext(handler: () => void, request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/**
 * Regression coverage for the sync rate-limit guard (backend-standard review,
 * sync §16): the sync surface previously had no identity-scoped rate limit at
 * all, only the generic per-IP DDoS backstop, which mobile carrier-NAT makes
 * ineffective as an abuse control.
 */
describe('SyncRateLimitGuard', () => {
  let redis: Redis;
  let guard: SyncRateLimitGuard;
  const controller = new FakeController();

  beforeAll(() => {
    redis = new Redis(env.REDIS_URL!);
    guard = new SyncRateLimitGuard(redis, new Reflector());
  });

  afterAll(async () => {
    redis.disconnect();
  });

  function request(userId: string, storeId: string, deviceId: string, body?: unknown) {
    return { user: { userId, deviceId }, params: { storeId }, body };
  }

  it('passes through routes with no @SyncRateLimit decorator', async () => {
    const ctx = fakeContext(controller.undecorated, request('u1', 's1', 'd1'));
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows requests under the changes budget and blocks once exceeded', async () => {
    const userId = `u-${Date.now()}`;
    const storeId = `s-${Date.now()}`;
    const deviceId = `d-${Date.now()}`;

    for (let i = 0; i < 60; i++) {
      const ctx = fakeContext(controller.changes, request(userId, storeId, deviceId));
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    }

    const ctx = fakeContext(controller.changes, request(userId, storeId, deviceId));
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ errorCode: 'RATE_LIMIT_EXCEEDED' });
  });

  it('keys the budget per device — a second device for the same (user, store) is unaffected', async () => {
    const userId = `u-${Date.now()}`;
    const storeId = `s-${Date.now()}`;

    for (let i = 0; i < 20; i++) {
      const ctx = fakeContext(controller.delta, request(userId, storeId, 'device-A', { mutations: [] }));
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    }
    // device-A is now exhausted for /delta...
    await expect(
      guard.canActivate(fakeContext(controller.delta, request(userId, storeId, 'device-A', { mutations: [] }))),
    ).rejects.toMatchObject({ errorCode: 'RATE_LIMIT_EXCEEDED' });

    // ...but device-B, same user+store, has its own independent budget.
    await expect(
      guard.canActivate(fakeContext(controller.delta, request(userId, storeId, 'device-B', { mutations: [] }))),
    ).resolves.toBe(true);
  });

  it('enforces the mutation-volume budget separately from the request-rate budget', async () => {
    const userId = `u-${Date.now()}`;
    const storeId = `s-${Date.now()}`;
    const deviceId = `d-${Date.now()}`;
    const bigBatch = Array.from({ length: 60 }, (_, i) => ({ mutation_id: String(i) }));

    // First call: 60 mutations, under the 100/5min budget, under the 20/min request budget.
    await expect(
      guard.canActivate(fakeContext(controller.delta, request(userId, storeId, deviceId, { mutations: bigBatch }))),
    ).resolves.toBe(true);

    // Second call: another 60 mutations pushes the cumulative volume to 120 > 100.
    await expect(
      guard.canActivate(fakeContext(controller.delta, request(userId, storeId, deviceId, { mutations: bigBatch }))),
    ).rejects.toMatchObject({ errorCode: 'RATE_LIMIT_EXCEEDED' });
  });
});