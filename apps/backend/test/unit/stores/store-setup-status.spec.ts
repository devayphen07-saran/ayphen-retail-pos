import { StoreService } from '../../../src/stores/store/store.service.js';
import type { StoreRepository } from '../../../src/stores/store/store.repository.js';
import type { UnitOfWork } from '../../../src/db/db.module.js';
import type { EntitlementService } from '../../../src/subscription/entitlement.service.js';
import type { RbacService } from '../../../src/common/rbac/rbac.service.js';
import type { AuditService } from '../../../src/common/audit/audit.service.js';
import type { SnapshotService } from '../../../src/auth/mobile/services/snapshot.service.js';

const STORE_ID = '22222222-2222-4222-8222-222222222222';

const FULL_PROFILE = {
  gstNumber: '29ABCDE1234F1Z5',
  address:   '123 Main St',
  phone:     '9999999999',
  email:     'store@example.com',
};

/** Builds a StoreService with every repo check stubbed independently, so each
 *  test can flip exactly one flag — getSetupStatus.repo is the only
 *  collaborator it touches; the rest are unused by this method. */
function makeService(overrides: Partial<StoreRepository> = {}): StoreService {
  const repo: Partial<StoreRepository> = {
    findProfileFields:      async () => FULL_PROFILE,
    hasAcceptedInvitation:  async () => true,
    hasActiveProduct:       async () => true,
    hasActivePaymentAccount: async () => true,
    hasTrustedDevice:       async () => true,
    ...overrides,
  };

  return new StoreService(
    {} as UnitOfWork,
    repo as StoreRepository,
    {} as EntitlementService,
    {} as RbacService,
    {} as AuditService,
    {} as SnapshotService,
  );
}

describe('StoreService.getSetupStatus', () => {
  it('reports 100% complete when every check passes', async () => {
    const service = makeService();
    const status = await service.getSetupStatus(STORE_ID);

    expect(status.totalChecks).toBe(5);
    expect(status.completedChecks).toBe(5);
    expect(status.completionPercentage).toBe(100);
    expect(status.statusMap).toEqual({
      storeProfileComplete: true,
      staffInvited:          true,
      productAdded:          true,
      paymentConfigured:     true,
      deviceLinked:          true,
    });
  });

  it('reports 0% when nothing is set up', async () => {
    const service = makeService({
      findProfileFields:       async () => null,
      hasAcceptedInvitation:   async () => false,
      hasActiveProduct:        async () => false,
      hasActivePaymentAccount: async () => false,
      hasTrustedDevice:        async () => false,
    });
    const status = await service.getSetupStatus(STORE_ID);

    expect(status.completedChecks).toBe(0);
    expect(status.completionPercentage).toBe(0);
    expect(status.statusMap.storeProfileComplete).toBe(false);
  });

  it('storeProfileComplete requires every profile field, not just some', async () => {
    const service = makeService({
      findProfileFields: async () => ({ ...FULL_PROFILE, email: null }),
    });
    const status = await service.getSetupStatus(STORE_ID);

    expect(status.statusMap.storeProfileComplete).toBe(false);
  });

  it('staffInvited is false when the profile has no accepted invitation', async () => {
    const service = makeService({ hasAcceptedInvitation: async () => false });
    const status = await service.getSetupStatus(STORE_ID);

    expect(status.statusMap.staffInvited).toBe(false);
    expect(status.completedChecks).toBe(4);
    expect(status.completionPercentage).toBe(80);
  });

  it('productAdded is false with no active product', async () => {
    const service = makeService({ hasActiveProduct: async () => false });
    const status = await service.getSetupStatus(STORE_ID);

    expect(status.statusMap.productAdded).toBe(false);
  });

  it('paymentConfigured is false with no active payment account', async () => {
    const service = makeService({ hasActivePaymentAccount: async () => false });
    const status = await service.getSetupStatus(STORE_ID);

    expect(status.statusMap.paymentConfigured).toBe(false);
  });

  it('deviceLinked is false with no trusted device', async () => {
    const service = makeService({ hasTrustedDevice: async () => false });
    const status = await service.getSetupStatus(STORE_ID);

    expect(status.statusMap.deviceLinked).toBe(false);
  });
});