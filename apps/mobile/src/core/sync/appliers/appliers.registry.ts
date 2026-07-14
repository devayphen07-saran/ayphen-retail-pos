import { storeRepository } from '../repositories/store.repository';
import { unitRepository } from '../repositories/unit.repository';
import { taxRateRepository } from '../repositories/tax-rate.repository';
import { lookupRepository } from '../repositories/lookup.repository';
import { paymentMethodRepository } from '../repositories/payment-method.repository';
import { paymentAccountRepository } from '../repositories/payment-account.repository';
import { productRepository } from '../repositories/product.repository';
import { productCaseRepository } from '../repositories/product-case.repository';
import { customerRepository } from '../repositories/customer.repository';
import { supplierRepository } from '../repositories/supplier.repository';
import { cashMovementRepository } from '../repositories/cash-movement.repository';
import { accountTransactionRepository } from '../repositories/account-transaction.repository';
import { saleRepository } from '../repositories/sale.repository';
import { saleLineRepository } from '../repositories/sale-line.repository';
import { salePaymentRepository } from '../repositories/sale-payment.repository';
import { refundRepository } from '../repositories/refund.repository';
import { refundLineRepository } from '../repositories/refund-line.repository';
import { customerLedgerEventRepository } from '../repositories/customer-ledger-event.repository';
import { customerPaymentRepository } from '../repositories/customer-payment.repository';
import { paymentAllocationRepository } from '../repositories/payment-allocation.repository';
import { supplierBillRepository } from '../repositories/supplier-bill.repository';
import { supplierPaymentRepository } from '../repositories/supplier-payment.repository';
import type { SyncApplier } from './applier.types';

function fromRepo(
  entityType: string,
  repo: {
    upsertAll: SyncApplier['upsertAll'];
    deleteByGuuids: SyncApplier['applyDeletes'];
    deleteAllForStore: SyncApplier['deleteAllForStore'];
  },
): SyncApplier {
  return {
    entityType,
    upsertAll: repo.upsertAll,
    applyDeletes: repo.deleteByGuuids,
    deleteAllForStore: repo.deleteAllForStore,
  };
}

/**
 * entity_type → applier. ONLY the entities this build has a local table for
 * are registered here — this list IS the client's `supported_entity_types`
 * (transport.ts sends `registry.entityTypes()` on every pull), so an entity
 * the mobile app doesn't understand yet is never dumped on it (the backend's
 * `SyncFilterRegistry.supported()` filters accordingly). Adding an entity
 * later (staff, store_device_access) is registration here + a repository,
 * never a change to the pull/push pipeline.
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
  fromRepo('paymentaccount', paymentAccountRepository),
  fromRepo('product', productRepository),
  fromRepo('product_case', productCaseRepository),
  fromRepo('customer', customerRepository),
  fromRepo('supplier', supplierRepository),
  fromRepo('cash_movement', cashMovementRepository),
  fromRepo('account_transaction', accountTransactionRepository),
  fromRepo('sale', saleRepository),
  fromRepo('sale_line', saleLineRepository),
  fromRepo('sale_payment', salePaymentRepository),
  fromRepo('refund', refundRepository),
  fromRepo('refund_line', refundLineRepository),
  fromRepo('customer_ledger_event', customerLedgerEventRepository),
  fromRepo('customer_payment', customerPaymentRepository),
  fromRepo('payment_allocation', paymentAllocationRepository),
  fromRepo('supplier_bill', supplierBillRepository),
  fromRepo('supplier_payment', supplierPaymentRepository),
  // Same underlying local table as 'payment_allocation' (§ backend
  // sync-filter.registry.ts comment) — the server splits the pull by
  // permission, the client just writes both into one repository.
  fromRepo('supplier_payment_allocation', paymentAllocationRepository),
]);
