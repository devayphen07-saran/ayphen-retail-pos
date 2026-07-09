import { ReconciliationService } from '../../../src/subscription/reconciliation.service.js';
import { UnprocessableError } from '../../../src/common/exceptions/app.exception.js';
import type { UnitOfWork } from '../../../src/db/db.module.js';
import type { SubscriptionRepository } from '../../../src/subscription/subscription.repository.js';
import type { EntitlementService } from '../../../src/subscription/entitlement.service.js';
import type { StoreRepository } from '../../../src/stores/store/store.repository.js';
import type {
  DeviceAccessRepository,
  StoreDeviceRowWithStore,
} from '../../../src/devices/device-access.repository.js';
import type { Redis } from 'ioredis';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID    = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STORE_A    = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STORE_B    = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE     = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SLOT_A     = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SLOT_B     = '11111111-1111-4111-8111-111111111111';

function slotRow(overrides: Partial<StoreDeviceRowWithStore>): StoreDeviceRowWithStore {
  return {
    id:              SLOT_A,
    storeFk:         STORE_A,
    deviceFk:        DEVICE,
    userFk:          USER_ID,
    status:          'active',
    deviceLabel:     null,
    lastAccessedAt:  new Date(),
    firstAccessedAt: new Date(),
    revokedAt:       null,
    revokedReason:   null,
    model:           'Pixel',
    platform:        'android',
    userName:        'Owner',
    ...overrides,
  };
}

/** Same device holding active slots in both STORE_A and STORE_B — the
 *  scenario the id-semantics fix and the self-lockout `.some()` fix both
 *  target. */
function makeTwoStoreDeviceContext() {
  return [
    slotRow({ id: SLOT_A, storeFk: STORE_A }),
    slotRow({ id: SLOT_B, storeFk: STORE_B }),
  ];
}

function makeService(deviceRows: StoreDeviceRowWithStore[], revokeSlotById: (...a: unknown[]) => unknown) {
  const uow: Partial<UnitOfWork> = {
    execute: (work) => work({} as never),
  };
  const subscriptions: Partial<SubscriptionRepository> = {
    findOwnedAccountId: async () => ACCOUNT_ID,
    applyTransition:    async () => undefined,
    enqueueOutbox:       async () => undefined,
  };
  const entitlements: Partial<EntitlementService> = {
    get: async (_accountId, key) => (key === 'max_stores' ? null : 5),
  };
  const stores: Partial<StoreRepository> = {
    listActiveStores: async () => [
      { id: STORE_A, name: 'Store A' },
      { id: STORE_B, name: 'Store B' },
    ],
    lockAccount: async () => undefined,
    lockMany:    async () => undefined,
  };
  const devices: Partial<DeviceAccessRepository> = {
    listStoreDevicesByStores: async () => deviceRows,
    revokeSlotById: revokeSlotById as DeviceAccessRepository['revokeSlotById'],
  };
  const redis: Partial<Redis> = { del: async () => 0 };

  return new ReconciliationService(
    uow as UnitOfWork,
    subscriptions as SubscriptionRepository,
    entitlements as EntitlementService,
    stores as StoreRepository,
    devices as DeviceAccessRepository,
    redis as Redis,
  );
}

describe('ReconciliationService self-lockout + slot-id keying', () => {
  it('allows keeping the current device via ONE of its two active-slot stores', async () => {
    const revokeSlotById = jest.fn(async () => 1);
    const service = makeService(makeTwoStoreDeviceContext(), revokeSlotById);

    // Device is active in both A and B; owner keeps A (with the device) and
    // drops B entirely. Old `.find()`-based self-lockout would only check
    // whichever entry it happened to encounter first and could reject this
    // even though the device stays reachable via A.
    await expect(
      service.applyForUser(USER_ID, DEVICE, {
        keepStoreIds:  [STORE_A],
        keepDeviceIds: [SLOT_A],
      }),
    ).resolves.toBeUndefined();

    // Store B is dropped wholesale (locked), so no per-device revoke call is
    // expected for it — only a kept store's non-kept devices get revoked.
    expect(revokeSlotById).not.toHaveBeenCalled();
  });

  it('rejects a selection that drops the current device from every store it holds a slot in', async () => {
    const revokeSlotById = jest.fn(async () => 1);
    const service = makeService(makeTwoStoreDeviceContext(), revokeSlotById);

    await expect(
      service.applyForUser(USER_ID, DEVICE, {
        keepStoreIds:  [STORE_A, STORE_B],
        keepDeviceIds: [], // current device kept nowhere
      }),
    ).rejects.toThrow(UnprocessableError);
  });

  it('revokes only the excluded store’s slot when the same device is kept in one store but not the other', async () => {
    const revokeSlotById = jest.fn(async () => 1);
    const service = makeService(makeTwoStoreDeviceContext(), revokeSlotById);

    await service.applyForUser(USER_ID, DEVICE, {
      keepStoreIds:  [STORE_A, STORE_B], // both stores kept...
      keepDeviceIds: [SLOT_A],           // ...but the device only kept in A
    });

    // Slot-id keying means dropping the device from B doesn't touch A's slot,
    // even though both slots share the same underlying deviceFk.
    expect(revokeSlotById).toHaveBeenCalledTimes(1);
    expect(revokeSlotById).toHaveBeenCalledWith(SLOT_B, USER_ID, 'plan_downgrade', expect.anything());
  });
});
