import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import { DRIZZLE, DbModule, type Database } from '../../../src/db/db.module';
import { MOBILE_REDIS } from '../../../src/auth/mobile/services/redis.provider';
import { AuditService } from '../../../src/auth/core/audit.service';
import { BlacklistCacheService } from '../../../src/auth/mobile/services/blacklist-cache.service';
import { SessionCacheInvalidatorService } from '../../../src/auth/mobile/services/session-cache-invalidator.service';
import { EntitlementService } from '../../../src/subscription/entitlement.service';
import { DeviceAccessRepository } from '../../../src/devices/device-access.repository';
import { DeviceAccessService } from '../../../src/devices/device-access.service';
import { DeviceRepository } from '../../../src/auth/mobile/repositories/device.repository';
import { AuthSessionRepository } from '../../../src/auth/mobile/repositories/auth-session.repository';
import { env } from '../../../src/config/env';
import {
  accounts,
  plans,
  planEntitlements,
  accountSubscriptions,
  stores,
  users,
  devices,
  storeDeviceAccess,
} from '../../../src/db/schema';

/**
 * Regression coverage for the device-slot-claim concurrency fix (flow-critic
 * review, Finding B): `claimSlot` must lock the store row before recounting
 * active slots, the same way `StoreService.createStore` locks the account row
 * and `InvitationService.createInvitation` locks the store row for their own
 * plan-entitlement checks. Without the lock, two different devices racing to
 * claim the last slot could both pass the count check and both insert,
 * exceeding max_devices_per_store (BR-DEV-018).
 */
describe('DeviceAccessService.claimSlot — concurrency', () => {
  let db: Database;
  let redis: Redis;
  let service: DeviceAccessService;
  let accountId: string;
  let storeId: string;
  let userAId: string;
  let userBId: string;
  let deviceAId: string;
  let deviceBId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule],
      providers: [
        DeviceAccessRepository,
        DeviceAccessService,
        DeviceRepository,
        AuthSessionRepository,
        EntitlementService,
        AuditService,
        BlacklistCacheService,
        SessionCacheInvalidatorService,
        { provide: MOBILE_REDIS, useFactory: () => new Redis(env.REDIS_URL!) },
      ],
    }).compile();

    db = moduleRef.get(DRIZZLE);
    redis = moduleRef.get(MOBILE_REDIS);
    service = moduleRef.get(DeviceAccessService);
  });

  afterAll(async () => {
    redis.disconnect();
  });

  beforeEach(async () => {
    await db.delete(storeDeviceAccess);
    await db.delete(devices);
    await db.delete(stores);
    await db.delete(accountSubscriptions);
    await db.delete(users);
    await db.delete(accounts);
    await db.delete(planEntitlements).where(eq(planEntitlements.key, 'max_devices_per_store'));
    await db.delete(plans).where(eq(plans.name, 'device-limit-test'));

    const [plan] = await db
      .insert(plans)
      .values({ name: 'device-limit-test', displayName: 'Device Limit (test)' })
      .returning();
    await db.insert(planEntitlements).values({ planFk: plan!.id, key: 'max_devices_per_store', value: 1 });

    const [account] = await db
      .insert(accounts)
      .values({ accountNumber: `ACC-${Date.now()}-${Math.random()}`, name: 'Test Account' })
      .returning();
    accountId = account!.id;
    await db.insert(accountSubscriptions).values({ accountFk: accountId, planFk: plan!.id });

    const [store] = await db
      .insert(stores)
      .values({ accountFk: accountId, name: 'Test Store' })
      .returning();
    storeId = store!.id;

    const [userA] = await db.insert(users).values({ name: 'User A', phone: `+1${Date.now()}A` }).returning();
    const [userB] = await db.insert(users).values({ name: 'User B', phone: `+1${Date.now()}B` }).returning();
    userAId = userA!.id;
    userBId = userB!.id;

    const [deviceA] = await db
      .insert(devices)
      .values({ userFk: userAId, publicKey: 'pkA', publicKeyHash: 'hA', platform: 'ios' })
      .returning();
    const [deviceB] = await db
      .insert(devices)
      .values({ userFk: userBId, publicKey: 'pkB', publicKeyHash: 'hB', platform: 'android' })
      .returning();
    deviceAId = deviceA!.id;
    deviceBId = deviceB!.id;
  });

  it('two different devices racing for the last slot: exactly one succeeds', async () => {
    const [a, b] = await Promise.allSettled([
      service.claimSlot(storeId, accountId, deviceAId, userAId),
      service.claimSlot(storeId, accountId, deviceBId, userBId),
    ]);

    const results = [a, b];
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason?.response?.message).toBe('DEVICE_LIMIT_REACHED');

    const activeSlots = await db
      .select()
      .from(storeDeviceAccess)
      .where(eq(storeDeviceAccess.storeFk, storeId));
    // The critical assertion: the store never ends up over its plan's limit,
    // even though two concurrent requests both raced for the same last slot.
    expect(activeSlots.filter((s) => s.status === 'active')).toHaveLength(1);
  });

  it('a single claim under the limit succeeds normally', async () => {
    const result = await service.claimSlot(storeId, accountId, deviceAId, userAId);
    expect(result).toEqual({ access: 'granted', isNew: true });
  });

  it('re-claiming an existing slot is idempotent (heartbeat, not a new row)', async () => {
    await service.claimSlot(storeId, accountId, deviceAId, userAId);
    const second = await service.claimSlot(storeId, accountId, deviceAId, userAId);
    expect(second).toEqual({ access: 'granted', isNew: false });

    const rows = await db
      .select()
      .from(storeDeviceAccess)
      .where(eq(storeDeviceAccess.deviceFk, deviceAId));
    expect(rows).toHaveLength(1);
  });
});
