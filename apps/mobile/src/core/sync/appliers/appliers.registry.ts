import { storeRepository } from '../repositories/store.repository';
import { unitRepository } from '../repositories/unit.repository';
import { taxRateRepository } from '../repositories/tax-rate.repository';
import { lookupRepository } from '../repositories/lookup.repository';
import { paymentMethodRepository } from '../repositories/payment-method.repository';
import { productRepository } from '../repositories/product.repository';
import { productCaseRepository } from '../repositories/product-case.repository';
import { customerRepository } from '../repositories/customer.repository';
import type { SyncApplier } from './applier.types';

function fromRepo(entityType: string, repo: { upsertAll: SyncApplier['upsertAll']; deleteByGuuids: SyncApplier['applyDeletes'] }): SyncApplier {
  return { entityType, upsertAll: repo.upsertAll, applyDeletes: repo.deleteByGuuids };
}

/**
 * entity_type → applier. ONLY the 8 entities this build has a local table for
 * are registered here — this list IS the client's `supported_entity_types`
 * (transport.ts sends `registry.entityTypes()` on every pull), so an entity
 * the mobile app doesn't understand yet is never dumped on it (the backend's
 * `SyncFilterRegistry.supported()` filters accordingly). Adding an entity
 * later (location, staff, supplier, paymentaccount, store_device_access) is
 * registration here + a repository, never a change to the pull/push pipeline.
 */
class AppliersRegistry {
  private readonly byType = new Map<string, SyncApplier>();

  constructor(appliers: SyncApplier[]) {
    for (const applier of appliers) {
      if (this.byType.has(applier.entityType)) {
        throw new Error(`[sync] duplicate applier registered for '${applier.entityType}'`);
      }
      this.byType.set(applier.entityType, applier);
    }
  }

  get(entityType: string): SyncApplier | undefined {
    return this.byType.get(entityType);
  }

  entityTypes(): string[] {
    return [...this.byType.keys()];
  }
}

export const appliersRegistry = new AppliersRegistry([
  fromRepo('store', storeRepository),
  fromRepo('unit', unitRepository),
  fromRepo('taxrate', taxRateRepository),
  fromRepo('lookup', lookupRepository),
  fromRepo('payment_method', paymentMethodRepository),
  fromRepo('product', productRepository),
  fromRepo('product_case', productCaseRepository),
  fromRepo('customer', customerRepository),
]);
