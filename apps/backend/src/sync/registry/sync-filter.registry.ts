import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  stores,
  units,
  storeDeviceAccess,
  lookup,
  paymentMethods,
  taxRates,
  users,
  userRoleMappings,
  products,
  productCases,
  paymentAccounts,
  customers,
  suppliers,
  cashMovements,
  accountTransactions,
  sales,
  saleLines,
  salePayments,
  refunds,
  refundLines,
  customerLedgerEvents,
  customerPayments,
  paymentAllocations,
  supplierBills,
  supplierPayments,
} from '#db/schema.js';
import { assertMicroIso, microIso } from '../us-timestamp.js';
import { readLagPredicate } from '../pull/read-cutoff.js';
import type { EntityWatermark } from '../cursor/sync-cursor.service.js';
import {
  GenericSyncFilter,
  ZERO_UUID,
  globalOrStoreScope,
  selfStoreScope,
  storeScope,
  type DeltaPage,
  type InitialPage,
  type SyncEntityFilter,
  type SyncPullContext,
} from './entity-filter.js';

/**
 * Staff (order 8): users who hold an active role in this store. No sync
 * columns of its own — the watermark is users.modified_at, which the
 * sync_touch trigger bumps on sync-relevant user changes AND on every
 * permissions_version bump (role grant/revoke touches the users row), so
 * role-membership changes re-deliver the affected staff row.
 */
class StaffSyncFilter implements SyncEntityFilter {
  readonly entityType = 'staff';
  readonly dependencyOrder = 80;
  readonly permissionEntity = 'User' as const;

  private selection() {
    return {
      id: users.id,
      guuid: users.guuid,
      name: users.name,
      phone: users.phone,
      email: users.email,
      status: users.status,
      modifiedAt: users.modifiedAt,
      __modifiedAtUs: microIso(users.modifiedAt),
    };
  }

  private toWire(row: Record<string, unknown>) {
    return {
      id: row.id,
      guuid: row.guuid,
      name: row.name,
      phone: row.phone,
      email: row.email,
      status: row.status,
      modified_at: assertMicroIso(String(row.__modifiedAtUs), this.entityType),
    };
  }

  private membershipJoin(ctx: SyncPullContext) {
    return and(
      eq(userRoleMappings.userFk, users.id),
      eq(userRoleMappings.storeFk, ctx.storeId),
      isNull(userRoleMappings.revokedAt),
    );
  }

  async pullChanges(
    ctx: SyncPullContext,
    after: EntityWatermark,
    limit: number,
    cutoff: string | null,
  ): Promise<DeltaPage> {
    const keyset = sql`(${users.modifiedAt} > ${after.ts}::timestamptz OR (${users.modifiedAt} = ${after.ts}::timestamptz AND ${users.id} > ${after.id || ZERO_UUID}::uuid))`;
    const lag = readLagPredicate(users.modifiedAt, cutoff);

    const rows = await ctx.db
      .selectDistinct(this.selection())
      .from(users)
      .innerJoin(userRoleMappings, this.membershipJoin(ctx))
      .where(and(isNull(users.deletedAt), keyset, lag))
      .orderBy(asc(users.modifiedAt), asc(users.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      rows: page.map((r) => this.toWire(r)),
      watermark: last
        ? { ts: assertMicroIso(String(last.__modifiedAtUs), this.entityType), id: String(last.id) }
        : null,
      hasMore,
    };
  }

  async pullInitial(ctx: SyncPullContext, afterId: string | null, limit: number): Promise<InitialPage> {
    const rows = await ctx.db
      .selectDistinct(this.selection())
      .from(users)
      .innerJoin(userRoleMappings, this.membershipJoin(ctx))
      .where(and(
        isNull(users.deletedAt),
        afterId ? sql`${users.id} > ${afterId}::uuid` : undefined,
      ))
      .orderBy(asc(users.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      rows: page.map((r) => this.toWire(r)),
      lastId: last ? String(last.id) : null,
      hasMore,
    };
  }

  async estimateCount(ctx: SyncPullContext): Promise<number> {
    const [row] = await ctx.db
      .select({ n: sql<number>`count(distinct ${users.id})::int` })
      .from(users)
      .innerJoin(userRoleMappings, this.membershipJoin(ctx))
      .where(isNull(users.deletedAt));
    return row?.n ?? 0;
  }
}

/**
 * The authoritative, dependency-ordered list of synced entities
 * (sync-engine.md §3). Cold start iterates in `dependencyOrder`; the mutation
 * side is a separate registry (MutationHandlerRegistry) — read and write
 * surfaces evolve independently.
 */
@Injectable()
export class SyncFilterRegistry {
  private readonly filters: SyncEntityFilter[];
  private readonly byType = new Map<string, SyncEntityFilter>();

  constructor() {
    this.filters = [
      new GenericSyncFilter({
        entityType: 'store',
        dependencyOrder: 10,
        permissionEntity: 'Store',
        table: stores,
        idColumn: stores.id,
        modifiedAtColumn: stores.modifiedAt,
        scopeWhere: selfStoreScope(stores.id),
        aliveWhere: isNull(stores.deletedAt),
        columns: {
          id: stores.id,
          guuid: stores.guuid,
          name: stores.name,
          gstNumber: stores.gstNumber,
          address: stores.address,
          phone: stores.phone,
          email: stores.email,
          invoicePrefix: stores.invoicePrefix,
          isActive: stores.isActive,
          locked: stores.locked,
          modifiedAt: stores.modifiedAt,
        },
      }),
      new GenericSyncFilter({
        entityType: 'unit',
        dependencyOrder: 20,
        permissionEntity: 'Store',
        table: units,
        idColumn: units.id,
        modifiedAtColumn: units.modifiedAt,
        scopeWhere: storeScope(units.storeFk),
        aliveWhere: isNull(units.deletedAt),
        columns: {
          id: units.id,
          name: units.name,
          abbreviation: units.abbreviation,
          allowsFractions: units.allowsFractions,
          isActive: units.isActive,
          guuid: units.guuid,
          rowVersion: units.rowVersion,
          modifiedAt: units.modifiedAt,
        },
      }),
      new GenericSyncFilter({
        entityType: 'store_device_access',
        dependencyOrder: 30,
        permissionEntity: 'Device',
        table: storeDeviceAccess,
        idColumn: storeDeviceAccess.id,
        modifiedAtColumn: storeDeviceAccess.modifiedAt,
        scopeWhere: storeScope(storeDeviceAccess.storeFk),
        columns: {
          id: storeDeviceAccess.id,
          guuid: storeDeviceAccess.guuid,
          deviceFk: storeDeviceAccess.deviceFk,
          userFk: storeDeviceAccess.userFk,
          status: storeDeviceAccess.status,
          deviceLabel: storeDeviceAccess.deviceLabel,
          lastAccessedAt: storeDeviceAccess.lastAccessedAt,
          revokedAt: storeDeviceAccess.revokedAt,
          modifiedAt: storeDeviceAccess.modifiedAt,
        },
      }),
      new GenericSyncFilter({
        entityType: 'lookup',
        dependencyOrder: 50,
        permissionEntity: 'Lookup',
        table: lookup,
        idColumn: lookup.id,
        modifiedAtColumn: lookup.modifiedAt,
        scopeWhere: globalOrStoreScope(lookup.storeFk),
        columns: {
          id: lookup.id,
          guuid: lookup.guuid,
          lookupTypeFk: lookup.lookupTypeFk,
          code: lookup.code,
          label: lookup.label,
          description: lookup.description,
          sortOrder: lookup.sortOrder,
          isHidden: lookup.isHidden,
          isSystem: lookup.isSystem,
          isActive: lookup.isActive,
          rowVersion: lookup.rowVersion,
          modifiedAt: lookup.modifiedAt,
        },
      }),
      new GenericSyncFilter({
        entityType: 'payment_method',
        dependencyOrder: 60,
        permissionEntity: 'Payment',
        table: paymentMethods,
        idColumn: paymentMethods.id,
        modifiedAtColumn: paymentMethods.modifiedAt,
        scopeWhere: storeScope(paymentMethods.storeFk),
        aliveWhere: isNull(paymentMethods.deletedAt),
        columns: {
          id: paymentMethods.id,
          code: paymentMethods.code,
          label: paymentMethods.label,
          kind: paymentMethods.kind,
          sortOrder: paymentMethods.sortOrder,
          isSystem: paymentMethods.isSystem,
          isActive: paymentMethods.isActive,
          guuid: paymentMethods.guuid,
          rowVersion: paymentMethods.rowVersion,
          modifiedAt: paymentMethods.modifiedAt,
        },
      }),
      new GenericSyncFilter({
        entityType: 'taxrate',
        dependencyOrder: 70,
        permissionEntity: 'TaxRate',
        table: taxRates,
        idColumn: taxRates.id,
        modifiedAtColumn: taxRates.modifiedAt,
        scopeWhere: storeScope(taxRates.storeFk),
        aliveWhere: isNull(taxRates.deletedAt),
        columns: {
          id: taxRates.id,
          name: taxRates.name,
          ratePercent: taxRates.ratePercent,
          isInclusive: taxRates.isInclusive,
          isActive: taxRates.isActive,
          guuid: taxRates.guuid,
          rowVersion: taxRates.rowVersion,
          modifiedAt: taxRates.modifiedAt,
        },
      }),
      new StaffSyncFilter(),
      new GenericSyncFilter({
        entityType: 'product',
        dependencyOrder: 90,
        permissionEntity: 'Product',
        table: products,
        idColumn: products.id,
        modifiedAtColumn: products.modifiedAt,
        scopeWhere: storeScope(products.storeFk),
        aliveWhere: isNull(products.deletedAt),
        columns: {
          id: products.id,
          name: products.name,
          sku: products.sku,
          barcode: products.barcode,
          categoryLookupFk: products.categoryLookupFk,
          unitFk: products.unitFk,
          taxrateFk: products.taxrateFk,
          sellingPrice: products.sellingPrice,
          costPrice: products.costPrice,
          mrp: products.mrp,
          hsnCode: products.hsnCode,
          trackInventory: products.trackInventory,
          isActive: products.isActive,
          guuid: products.guuid,
          rowVersion: products.rowVersion,
          modifiedAt: products.modifiedAt,
        },
      }),
      new GenericSyncFilter({
        entityType: 'product_case',
        dependencyOrder: 100,
        permissionEntity: 'Product',
        table: productCases,
        idColumn: productCases.id,
        modifiedAtColumn: productCases.modifiedAt,
        scopeWhere: storeScope(productCases.storeFk),
        aliveWhere: isNull(productCases.deletedAt),
        columns: {
          id: productCases.id,
          productFk: productCases.productFk,
          name: productCases.name,
          quantity: productCases.quantity,
          barcode: productCases.barcode,
          sellingPrice: productCases.sellingPrice,
          isActive: productCases.isActive,
          guuid: productCases.guuid,
          rowVersion: productCases.rowVersion,
          modifiedAt: productCases.modifiedAt,
        },
      }),
      new GenericSyncFilter({
        entityType: 'paymentaccount',
        dependencyOrder: 110,
        permissionEntity: 'Payment',
        table: paymentAccounts,
        idColumn: paymentAccounts.id,
        modifiedAtColumn: paymentAccounts.modifiedAt,
        scopeWhere: storeScope(paymentAccounts.storeFk),
        aliveWhere: isNull(paymentAccounts.deletedAt),
        columns: {
          id: paymentAccounts.id,
          name: paymentAccounts.name,
          kind: paymentAccounts.kind,
          details: paymentAccounts.details,
          isDefault: paymentAccounts.isDefault,
          isActive: paymentAccounts.isActive,
          // Seed lock + discriminator so the client can render the locked Cash/
          // Bank rows and find "the cash account" (PRD §BR-4 / OQ-1).
          isSystem: paymentAccounts.isSystem,
          systemKey: paymentAccounts.systemKey,
          guuid: paymentAccounts.guuid,
          rowVersion: paymentAccounts.rowVersion,
          modifiedAt: paymentAccounts.modifiedAt,
        },
      }),
      new GenericSyncFilter({
        entityType: 'customer',
        dependencyOrder: 120,
        permissionEntity: 'Customer',
        table: customers,
        idColumn: customers.id,
        modifiedAtColumn: customers.modifiedAt,
        scopeWhere: storeScope(customers.storeFk),
        aliveWhere: isNull(customers.deletedAt),
        columns: {
          id: customers.id,
          name: customers.name,
          phone: customers.phone,
          email: customers.email,
          website: customers.website,
          logoUri: customers.logoUri,
          gstNumber: customers.gstNumber,
          panNumber: customers.panNumber,
          customerTypeLookupFk: customers.customerTypeLookupFk,
          creditLimit: customers.creditLimit,
          overrideCreditLimit: customers.overrideCreditLimit,
          paymentTermLookupFk: customers.paymentTermLookupFk,
          paymentTermDays: customers.paymentTermDays,
          addressLine1: customers.addressLine1,
          addressLine2: customers.addressLine2,
          city: customers.city,
          district: customers.district,
          stateLookupFk: customers.stateLookupFk,
          pinCode: customers.pinCode,
          birthday: customers.birthday,
          anniversary: customers.anniversary,
          notes: customers.notes,
          isActive: customers.isActive,
          guuid: customers.guuid,
          rowVersion: customers.rowVersion,
          modifiedAt: customers.modifiedAt,
        },
      }),
      new GenericSyncFilter({
        entityType: 'supplier',
        dependencyOrder: 130,
        permissionEntity: 'Supplier',
        table: suppliers,
        idColumn: suppliers.id,
        modifiedAtColumn: suppliers.modifiedAt,
        scopeWhere: storeScope(suppliers.storeFk),
        aliveWhere: isNull(suppliers.deletedAt),
        columns: {
          id: suppliers.id,
          name: suppliers.name,
          displayName: suppliers.displayName,
          phone: suppliers.phone,
          email: suppliers.email,
          website: suppliers.website,
          logoUri: suppliers.logoUri,
          gstNumber: suppliers.gstNumber,
          panNumber: suppliers.panNumber,
          paymentTermLookupFk: suppliers.paymentTermLookupFk,
          paymentTermDays: suppliers.paymentTermDays,
          creditLimit: suppliers.creditLimit,
          overrideCreditLimit: suppliers.overrideCreditLimit,
          addressLine1: suppliers.addressLine1,
          addressLine2: suppliers.addressLine2,
          city: suppliers.city,
          district: suppliers.district,
          stateLookupFk: suppliers.stateLookupFk,
          pinCode: suppliers.pinCode,
          notes: suppliers.notes,
          isActive: suppliers.isActive,
          guuid: suppliers.guuid,
          rowVersion: suppliers.rowVersion,
          modifiedAt: suppliers.modifiedAt,
        },
      }),
      // Append-only (docs/prd/accounts-and-ledger.md D1) — no aliveWhere:
      // these rows are never soft-deleted, corrections are new events.
      new GenericSyncFilter({
        entityType: 'cash_movement',
        dependencyOrder: 140,
        permissionEntity: 'CashMovement',
        table: cashMovements,
        idColumn: cashMovements.id,
        modifiedAtColumn: cashMovements.modifiedAt,
        scopeWhere: storeScope(cashMovements.storeFk),
        columns: {
          id: cashMovements.id,
          guuid: cashMovements.guuid,
          accountFk: cashMovements.accountFk,
          type: cashMovements.type,
          reason: cashMovements.reason,
          amountPaise: cashMovements.amountPaise,
          byUserFk: cashMovements.byUserFk,
          rowVersion: cashMovements.rowVersion,
          modifiedAt: cashMovements.modifiedAt,
        },
      }),
      // Server-derived projection (BR-3) — pull-only, no mutation handler:
      // a client can never push one of these directly.
      new GenericSyncFilter({
        entityType: 'account_transaction',
        dependencyOrder: 150,
        permissionEntity: 'Payment',
        table: accountTransactions,
        idColumn: accountTransactions.id,
        modifiedAtColumn: accountTransactions.modifiedAt,
        scopeWhere: storeScope(accountTransactions.storeFk),
        columns: {
          id: accountTransactions.id,
          guuid: accountTransactions.guuid,
          accountFk: accountTransactions.accountFk,
          direction: accountTransactions.direction,
          amountPaise: accountTransactions.amountPaise,
          reason: accountTransactions.reason,
          sourceType: accountTransactions.sourceType,
          sourceFk: accountTransactions.sourceFk,
          shiftSessionFk: accountTransactions.shiftSessionFk,
          note: accountTransactions.note,
          rowVersion: accountTransactions.rowVersion,
          modifiedAt: accountTransactions.modifiedAt,
        },
      }),
      // Composite mutation entity (F2/F3): the ONLY pushed row here — lines/
      // payments below are pull-only children written solely by this handler.
      new GenericSyncFilter({
        entityType: 'sale',
        dependencyOrder: 160,
        permissionEntity: 'Sale',
        table: sales,
        idColumn: sales.id,
        modifiedAtColumn: sales.modifiedAt,
        scopeWhere: storeScope(sales.storeFk),
        columns: {
          id: sales.id,
          guuid: sales.guuid,
          customerFk: sales.customerFk,
          totalPaise: sales.totalPaise,
          status: sales.status,
          invoiceNo: sales.invoiceNo,
          soldAt: sales.soldAt,
          rowVersion: sales.rowVersion,
          modifiedAt: sales.modifiedAt,
        },
      }),
      // Pull-only (BR-3-style: no push handler) — written only by SaleMutationHandler.
      new GenericSyncFilter({
        entityType: 'sale_line',
        dependencyOrder: 161,
        permissionEntity: 'Sale',
        table: saleLines,
        idColumn: saleLines.id,
        modifiedAtColumn: saleLines.modifiedAt,
        scopeWhere: storeScope(saleLines.storeFk),
        columns: {
          id: saleLines.id,
          guuid: saleLines.guuid,
          saleFk: saleLines.saleFk,
          productFk: saleLines.productFk,
          qty: saleLines.qty,
          unitPricePaise: saleLines.unitPricePaise,
          discountPaise: saleLines.discountPaise,
          lineTotalPaise: saleLines.lineTotalPaise,
          rowVersion: saleLines.rowVersion,
          modifiedAt: saleLines.modifiedAt,
        },
      }),
      new GenericSyncFilter({
        entityType: 'sale_payment',
        dependencyOrder: 162,
        permissionEntity: 'Sale',
        table: salePayments,
        idColumn: salePayments.id,
        modifiedAtColumn: salePayments.modifiedAt,
        scopeWhere: storeScope(salePayments.storeFk),
        columns: {
          id: salePayments.id,
          guuid: salePayments.guuid,
          saleFk: salePayments.saleFk,
          accountFk: salePayments.accountFk,
          tender: salePayments.tender,
          amountPaise: salePayments.amountPaise,
          onCredit: salePayments.onCredit,
          rowVersion: salePayments.rowVersion,
          modifiedAt: salePayments.modifiedAt,
        },
      }),
      // Composite mutation entity (F3): the only pushed row — refund_line below
      // is pull-only, written solely by this handler.
      new GenericSyncFilter({
        entityType: 'refund',
        dependencyOrder: 163,
        permissionEntity: 'Refund',
        table: refunds,
        idColumn: refunds.id,
        modifiedAtColumn: refunds.modifiedAt,
        scopeWhere: storeScope(refunds.storeFk),
        columns: {
          id: refunds.id,
          guuid: refunds.guuid,
          saleFk: refunds.saleFk,
          accountFk: refunds.accountFk,
          amountPaise: refunds.amountPaise,
          reason: refunds.reason,
          refundedAt: refunds.refundedAt,
          rowVersion: refunds.rowVersion,
          modifiedAt: refunds.modifiedAt,
        },
      }),
      new GenericSyncFilter({
        entityType: 'refund_line',
        dependencyOrder: 164,
        permissionEntity: 'Refund',
        table: refundLines,
        idColumn: refundLines.id,
        modifiedAtColumn: refundLines.modifiedAt,
        scopeWhere: storeScope(refundLines.storeFk),
        columns: {
          id: refundLines.id,
          guuid: refundLines.guuid,
          refundFk: refundLines.refundFk,
          saleLineFk: refundLines.saleLineFk,
          qty: refundLines.qty,
          amountPaise: refundLines.amountPaise,
          rowVersion: refundLines.rowVersion,
          modifiedAt: refundLines.modifiedAt,
        },
      }),
      // Server-derived projection (BR-3-style) — pull-only, no push handler:
      // written by sale.handler.ts's credit portion and by
      // customer-payment.handler.ts's settlement.
      new GenericSyncFilter({
        entityType: 'customer_ledger_event',
        dependencyOrder: 170,
        permissionEntity: 'Customer',
        table: customerLedgerEvents,
        idColumn: customerLedgerEvents.id,
        modifiedAtColumn: customerLedgerEvents.modifiedAt,
        scopeWhere: storeScope(customerLedgerEvents.storeFk),
        columns: {
          id: customerLedgerEvents.id,
          guuid: customerLedgerEvents.guuid,
          customerFk: customerLedgerEvents.customerFk,
          kind: customerLedgerEvents.kind,
          amountPaise: customerLedgerEvents.amountPaise,
          sourceType: customerLedgerEvents.sourceType,
          sourceFk: customerLedgerEvents.sourceFk,
          flagged: customerLedgerEvents.flagged,
          rowVersion: customerLedgerEvents.rowVersion,
          modifiedAt: customerLedgerEvents.modifiedAt,
        },
      }),
      // Composite mutation entity (F5 settlement): the only pushed row —
      // payment_allocation below is pull-only, written solely by this handler.
      new GenericSyncFilter({
        entityType: 'customer_payment',
        dependencyOrder: 171,
        permissionEntity: 'Customer',
        table: customerPayments,
        idColumn: customerPayments.id,
        modifiedAtColumn: customerPayments.modifiedAt,
        scopeWhere: storeScope(customerPayments.storeFk),
        columns: {
          id: customerPayments.id,
          guuid: customerPayments.guuid,
          customerFk: customerPayments.customerFk,
          accountFk: customerPayments.accountFk,
          amountPaise: customerPayments.amountPaise,
          paidAt: customerPayments.paidAt,
          rowVersion: customerPayments.rowVersion,
          modifiedAt: customerPayments.modifiedAt,
        },
      }),
      // `payment_allocations` is shared by both settlement sides (customer
      // sale-allocations vs supplier bill-allocations, D10) — split into two
      // sync entity types over the SAME table, each scoped by target_type AND
      // gated by the matching permission, rather than one filter gated on a
      // single entity: gating everything on 'Customer' would leak a
      // supplier-payment's amount to a user who can't view Supplier data (and
      // vice versa a Supplier-only viewer would miss the sale-side rows).
      new GenericSyncFilter({
        entityType: 'payment_allocation',
        dependencyOrder: 172,
        permissionEntity: 'Customer',
        table: paymentAllocations,
        idColumn: paymentAllocations.id,
        modifiedAtColumn: paymentAllocations.modifiedAt,
        scopeWhere: (ctx) => and(storeScope(paymentAllocations.storeFk)(ctx), eq(paymentAllocations.targetType, 'sale')),
        columns: {
          id: paymentAllocations.id,
          guuid: paymentAllocations.guuid,
          paymentFk: paymentAllocations.paymentFk,
          targetType: paymentAllocations.targetType,
          targetFk: paymentAllocations.targetFk,
          appliedPaise: paymentAllocations.appliedPaise,
          rowVersion: paymentAllocations.rowVersion,
          modifiedAt: paymentAllocations.modifiedAt,
        },
      }),
      new GenericSyncFilter({
        entityType: 'supplier_payment_allocation',
        dependencyOrder: 182,
        permissionEntity: 'SupplierPayment',
        table: paymentAllocations,
        idColumn: paymentAllocations.id,
        modifiedAtColumn: paymentAllocations.modifiedAt,
        scopeWhere: (ctx) => and(storeScope(paymentAllocations.storeFk)(ctx), eq(paymentAllocations.targetType, 'bill')),
        columns: {
          id: paymentAllocations.id,
          guuid: paymentAllocations.guuid,
          paymentFk: paymentAllocations.paymentFk,
          targetType: paymentAllocations.targetType,
          targetFk: paymentAllocations.targetFk,
          appliedPaise: paymentAllocations.appliedPaise,
          rowVersion: paymentAllocations.rowVersion,
          modifiedAt: paymentAllocations.modifiedAt,
        },
      }),
      new GenericSyncFilter({
        entityType: 'supplier_bill',
        dependencyOrder: 180,
        permissionEntity: 'SupplierBill',
        table: supplierBills,
        idColumn: supplierBills.id,
        modifiedAtColumn: supplierBills.modifiedAt,
        scopeWhere: storeScope(supplierBills.storeFk),
        columns: {
          id: supplierBills.id,
          guuid: supplierBills.guuid,
          supplierFk: supplierBills.supplierFk,
          billNo: supplierBills.billNo,
          amountPaise: supplierBills.amountPaise,
          billDate: supplierBills.billDate,
          dueDate: supplierBills.dueDate,
          status: supplierBills.status,
          notes: supplierBills.notes,
          rowVersion: supplierBills.rowVersion,
          modifiedAt: supplierBills.modifiedAt,
        },
      }),
      new GenericSyncFilter({
        entityType: 'supplier_payment',
        dependencyOrder: 181,
        permissionEntity: 'SupplierPayment',
        table: supplierPayments,
        idColumn: supplierPayments.id,
        modifiedAtColumn: supplierPayments.modifiedAt,
        scopeWhere: storeScope(supplierPayments.storeFk),
        aliveWhere: isNull(supplierPayments.deletedAt),
        columns: {
          id: supplierPayments.id,
          guuid: supplierPayments.guuid,
          supplierFk: supplierPayments.supplierFk,
          accountFk: supplierPayments.accountFk,
          amountPaise: supplierPayments.amountPaise,
          paidAt: supplierPayments.paidAt,
          rowVersion: supplierPayments.rowVersion,
          modifiedAt: supplierPayments.modifiedAt,
        },
      }),
    ].sort((a, b) => a.dependencyOrder - b.dependencyOrder);

    // dependencyOrder must be a TOTAL order — cold start applies entities in
    // this sequence for FK safety, and a tie would resolve only by V8's stable
    // sort (i.e. array insertion order), which is too implicit to depend on.
    // Values are spaced by 10 so a new entity can slot between two others
    // without a renumber; this guard fails fast if a future addition collides.
    const orders = this.filters.map((f) => f.dependencyOrder);
    if (new Set(orders).size !== orders.length) {
      throw new Error('[sync] duplicate dependencyOrder — cold-start ordering must be a total order');
    }

    for (const f of this.filters) this.byType.set(f.entityType, f);
  }

  all(): SyncEntityFilter[] {
    return this.filters;
  }

  get(entityType: string): SyncEntityFilter | undefined {
    return this.byType.get(entityType);
  }

  /** Registry ∩ the client's supported_entity_types (older builds skip newer entities). */
  supported(supportedEntityTypes?: string[]): SyncEntityFilter[] {
    if (!supportedEntityTypes?.length) return this.filters;
    const wanted = new Set(supportedEntityTypes);
    return this.filters.filter((f) => wanted.has(f.entityType));
  }

  /**
   * Requested types with no matching filter at all — distinct from an older
   * client simply not yet knowing about a newer entity (that's `supported()`'s
   * normal narrowing). This is the opposite direction: a client asked for a
   * type this server has never heard of, which today `supported()` would
   * silently just drop forever with no error anywhere (e.g. a casing typo
   * against the intentionally-non-snake_case wire strings like `taxrate` —
   * see sync.constants.ts). Callers should log this, not throw: an unknown
   * requested type must never break an otherwise-valid pull for every other
   * entity, but it should be visible in logs instead of vanishing silently.
   */
  unknownTypes(supportedEntityTypes?: string[]): string[] {
    if (!supportedEntityTypes?.length) return [];
    return supportedEntityTypes.filter((t) => !this.byType.has(t));
  }
}
