import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  stores,
  units,
  storeDeviceAccess,
  lookup,
  paymentMethods,
  taxRates,
  locations,
  users,
  userRoleMappings,
  products,
  productCases,
  paymentAccounts,
  customers,
  suppliers,
} from '#db/schema.js';
import { READ_SAFETY_LAG_MS } from '../sync.constants.js';
import { assertMicroIso, microIso } from '../us-timestamp.js';
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

  async pullChanges(ctx: SyncPullContext, after: EntityWatermark, limit: number): Promise<DeltaPage> {
    const keyset = sql`(${users.modifiedAt} > ${after.ts}::timestamptz OR (${users.modifiedAt} = ${after.ts}::timestamptz AND ${users.id} > ${after.id || ZERO_UUID}::uuid))`;
    const lag = sql`${users.modifiedAt} < now() - make_interval(secs => ${READ_SAFETY_LAG_MS / 1000})`;

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
          locationFk: storeDeviceAccess.locationFk,
          status: storeDeviceAccess.status,
          deviceLabel: storeDeviceAccess.deviceLabel,
          lastAccessedAt: storeDeviceAccess.lastAccessedAt,
          revokedAt: storeDeviceAccess.revokedAt,
          modifiedAt: storeDeviceAccess.modifiedAt,
        },
      }),
      new GenericSyncFilter({
        entityType: 'location',
        dependencyOrder: 40,
        permissionEntity: 'Location',
        table: locations,
        idColumn: locations.id,
        modifiedAtColumn: locations.modifiedAt,
        scopeWhere: storeScope(locations.storeFk),
        aliveWhere: eq(locations.isActive, true),
        columns: {
          id: locations.id,
          guuid: locations.guuid,
          name: locations.name,
          isPrimary: locations.isPrimary,
          isDefault: locations.isDefault,
          enable: locations.enable,
          displayOrder: locations.displayOrder,
          locked: locations.locked,
          rowVersion: locations.rowVersion,
          modifiedAt: locations.modifiedAt,
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
          paymentMethodFk: paymentAccounts.paymentMethodFk,
          details: paymentAccounts.details,
          isDefault: paymentAccounts.isDefault,
          isActive: paymentAccounts.isActive,
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
          gstNumber: customers.gstNumber,
          customerTypeLookupFk: customers.customerTypeLookupFk,
          creditLimit: customers.creditLimit,
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
          phone: suppliers.phone,
          email: suppliers.email,
          gstNumber: suppliers.gstNumber,
          isActive: suppliers.isActive,
          guuid: suppliers.guuid,
          rowVersion: suppliers.rowVersion,
          modifiedAt: suppliers.modifiedAt,
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
}
