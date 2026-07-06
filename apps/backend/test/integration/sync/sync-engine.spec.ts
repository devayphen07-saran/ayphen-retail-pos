import { Test } from '@nestjs/testing';
import { DRIZZLE, DbModule, UnitOfWork, type Database } from '../../../src/db/db.module';
import {
  accounts,
  accountSubscriptions,
  devices,
  plans,
  stores,
  syncTombstones,
  users,
} from '../../../src/db/schema';
import { SyncCursorService } from '../../../src/sync/cursor/sync-cursor.service';
import { SyncFilterRegistry } from '../../../src/sync/registry/sync-filter.registry';
import { TombstoneRepository } from '../../../src/sync/repositories/tombstone.repository';
import { SyncInitProgressRepository } from '../../../src/sync/repositories/sync-init-progress.repository';
import { SyncIdempotencyRepository } from '../../../src/sync/repositories/sync-idempotency.repository';
import { SyncMutationFailureRepository } from '../../../src/sync/repositories/sync-mutation-failure.repository';
import { SyncConflictRepository } from '../../../src/sync/repositories/sync-conflict.repository';
import { SyncChangesService } from '../../../src/sync/pull/changes.service';
import { InitialSyncService } from '../../../src/sync/pull/initial-sync.service';
import { SyncDeltaService } from '../../../src/sync/push/delta.service';
import { MutationHandlerRegistry } from '../../../src/sync/push/mutation-handler.registry';
import { ProductMutationHandler, ProductCaseMutationHandler } from '../../../src/sync/push/handlers/product.handler';
import { CustomerMutationHandler } from '../../../src/sync/push/handlers/customer.handler';
import { SupplierMutationHandler } from '../../../src/sync/push/handlers/supplier.handler';
import { PaymentAccountMutationHandler } from '../../../src/sync/push/handlers/payment-account.handler';
import { LookupMutationHandler } from '../../../src/sync/push/handlers/lookup.handler';
import { MICRO_ISO_RE } from '../../../src/sync/us-timestamp';
import { READ_SAFETY_LAG_MS } from '../../../src/sync/sync.constants';
import type { AppConfigService } from '../../../src/config/app-config.service';
import type { RbacService } from '../../../src/common/rbac/rbac.service';
import type { RbacRepository } from '../../../src/common/rbac/rbac.repository';
import type { AuthSessionRepository } from '../../../src/auth/mobile/repositories/auth-session.repository';
import type { SnapshotService } from '../../../src/auth/mobile/services/snapshot.service';
import type { MobilePrincipal } from '../../../src/auth/mobile/types/mobile-principal';

/**
 * Two-device sync round trip against the real Postgres container (triggers
 * included — migration 0019). Covers the M2 acceptance path: cold start →
 * push → delta pull on the other device → optimistic-lock conflict →
 * idempotent replay → delete/tombstone propagation → parent cascade.
 *
 * RBAC is stubbed permissive (every entity view/edit granted) — permission
 * filtering has its own unit-level coverage; this spec is about the sync
 * protocol invariants.
 */

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = () =>
  Array.from({ length: 26 }, () => ULID_ALPHABET[Math.floor(Math.random() * 32)]).join('');

const uuid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Outwait the read-side safety lag so freshly-written rows become pullable. */
const outwaitLag = () => sleep(READ_SAFETY_LAG_MS + 300);

describe('sync engine — two-device round trip', () => {
  let db: Database;
  let cursors: SyncCursorService;
  let registry: SyncFilterRegistry;
  let tombstones: TombstoneRepository;
  let initial: InitialSyncService;
  let changes: SyncChangesService;
  let delta: SyncDeltaService;

  let storeId: string;
  let accountId: string;
  let userId: string;
  let deviceA: string;
  let deviceB: string;

  const rbacStub = {
    getCachedPermissions: async () => ({ crud: new Map(), special: new Map() }),
    checkCrud: () => true,
  } as unknown as RbacService;

  const principal = (deviceId: string): MobilePrincipal => ({
    userId,
    userGuuid: uuid(),
    deviceSessionId: uuid(),
    deviceId,
    devicePlatform: 'ios',
    permissionsVersion: 1,
    jwtPv: 1,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DbModule] }).compile();
    db = moduleRef.get(DRIZZLE);

    cursors = new SyncCursorService({ syncRootSecret: 'integration-secret-0123456789abcdef' } as AppConfigService);
    cursors.onModuleInit();

    registry = new SyncFilterRegistry();
    tombstones = new TombstoneRepository();
    const progress = new SyncInitProgressRepository(db);
    const idempotency = new SyncIdempotencyRepository(db);
    const failures = new SyncMutationFailureRepository(db);
    const conflicts = new SyncConflictRepository(db);

    initial = new InitialSyncService(db, registry, cursors, rbacStub, progress);
    changes = new SyncChangesService(db, registry, cursors, rbacStub, tombstones);

    const handlers = new MutationHandlerRegistry([
      new LookupMutationHandler(tombstones),
      new ProductMutationHandler(tombstones),
      new ProductCaseMutationHandler(tombstones),
      new CustomerMutationHandler(tombstones),
      new SupplierMutationHandler(tombstones),
      new PaymentAccountMutationHandler(tombstones),
    ]);

    const sessionsStub = {
      findById: async () => null,
    } as unknown as AuthSessionRepository;
    const snapshotsStub = {
      getOrBuild: async () => null,
    } as unknown as SnapshotService;

    delta = new SyncDeltaService(
      db,
      new UnitOfWork(db),
      handlers,
      idempotency,
      failures,
      conflicts,
      rbacStub,
      { wasCrudAuthorizedAt: async () => true } as unknown as RbacRepository,
      sessionsStub,
      snapshotsStub,
      changes,
      cursors,
    );
  });

  beforeEach(async () => {
    const [account] = await db
      .insert(accounts)
      .values({ accountNumber: `ACC-${Date.now()}-${Math.random()}`, name: 'Sync Test Account' })
      .returning();
    accountId = account!.id;

    const [plan] = await db
      .insert(plans)
      .values({ name: `starter-${Date.now()}-${Math.random()}`, displayName: 'Starter' })
      .returning();
    await db.insert(accountSubscriptions).values({
      accountFk: accountId,
      planFk: plan!.id,
      status: 'trialing',
    });

    const [store] = await db
      .insert(stores)
      .values({ accountFk: accountId, name: 'Sync Store' })
      .returning();
    storeId = store!.id;

    const [user] = await db
      .insert(users)
      .values({ phone: `+9198${String(Date.now()).slice(-8)}`, name: 'Sync User' })
      .returning();
    userId = user!.id;

    const mkDevice = async () => {
      const [d] = await db
        .insert(devices)
        .values({
          userFk: userId,
          publicKey: 'pk',
          publicKeyHash: uuid(),
          platform: 'ios',
        })
        .returning();
      return d!.id;
    };
    deviceA = await mkDevice();
    deviceB = await mkDevice();
  });

  /** Run a device's full cold start; returns its first delta cursor. */
  async function coldStart(deviceId: string): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const page = await initial.pull(userId, deviceId, storeId, {});
      if (page.all_entities_complete) return page.next_delta_cursor!;
    }
    throw new Error('cold start did not complete in 50 pages');
  }

  it('cold-starts, pushes a product on device A, and delivers it to device B with a µs watermark', async () => {
    const cursorA = await coldStart(deviceA);
    const cursorB = await coldStart(deviceB);
    expect(cursorA).toBeTruthy();

    const productGuuid = uuid();
    const result = await delta.process(principal(deviceA), { storeId, accountId }, {
      sync_cursor: cursorA,
      mutations: [
        {
          mutation_id: ulid(),
          entity_type: 'product',
          action: 'create',
          client_modified_at: new Date().toISOString(),
          payload: { guuid: productGuuid, name: 'Masala Chai 250g', selling_price: 149, sku: 'CHAI-250' },
        },
      ],
    });

    expect(result.mutation_results).toHaveLength(1);
    expect(result.mutation_results[0]).toMatchObject({
      status: 'applied',
      entity_guuid: productGuuid,
      row_version: 1,
    });

    await outwaitLag();
    const pulled = await changes.pull(userId, storeId, cursorB);
    const upserts = pulled.changes.product?.upserts ?? [];
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ guuid: productGuuid, name: 'Masala Chai 250g' });
    // BR-SYNC-004: the watermark rides the wire as a 6-decimal µs string.
    expect(String(upserts[0]!.modified_at)).toMatch(MICRO_ISO_RE);
  });

  it('replays a duplicate mutation_id from the cache instead of re-applying (§10)', async () => {
    const cursorA = await coldStart(deviceA);
    const mutationId = ulid();
    const guuid = uuid();
    const mutation = {
      mutation_id: mutationId,
      entity_type: 'customer',
      action: 'create' as const,
      payload: { guuid, name: 'Ravi Kumar', phone: '+919876543210' },
    };

    const first = await delta.process(principal(deviceA), { storeId, accountId }, {
      sync_cursor: cursorA, mutations: [mutation],
    });
    expect(first.mutation_results[0]).toMatchObject({ status: 'applied' });

    const retry = await delta.process(principal(deviceA), { storeId, accountId }, {
      sync_cursor: cursorA, mutations: [mutation],
    });
    expect(retry.mutation_results[0]).toMatchObject({ status: 'duplicate' });
    expect((retry.mutation_results[0] as { cached: { status: string } }).cached.status).toBe('applied');
  });

  it('stale expected_row_version → MASTER_DATA conflict with server_row; fresh version applies (§11)', async () => {
    const cursorA = await coldStart(deviceA);
    const guuid = uuid();

    await delta.process(principal(deviceA), { storeId, accountId }, {
      sync_cursor: cursorA,
      mutations: [{
        mutation_id: ulid(), entity_type: 'supplier', action: 'create',
        payload: { guuid, name: 'Original Traders' },
      }],
    });

    // Server-side edit bumps row_version via the trigger.
    const good = await delta.process(principal(deviceA), { storeId, accountId }, {
      mutations: [{
        mutation_id: ulid(), entity_type: 'supplier', action: 'update',
        expected_row_version: 1,
        payload: { guuid, name: 'Renamed Traders' },
      }],
    });
    expect(good.mutation_results[0]).toMatchObject({ status: 'applied', row_version: 2 });

    // A second editor still holding version 1 must conflict, not clobber.
    const stale = await delta.process(principal(deviceB), { storeId, accountId }, {
      mutations: [{
        mutation_id: ulid(), entity_type: 'supplier', action: 'update',
        expected_row_version: 1,
        payload: { guuid, name: 'Clobber Attempt' },
      }],
    });
    expect(stale.mutation_results[0]).toMatchObject({ status: 'conflict', conflict_type: 'MASTER_DATA' });
    const serverRow = (stale.mutation_results[0] as { server_row: Record<string, unknown> }).server_row;
    expect(serverRow).toMatchObject({ name: 'Renamed Traders', row_version: 2 });
  });

  it('update without expected_row_version is rejected with SYNC_MISSING_ROW_VERSION (§9 preflight)', async () => {
    const res = await delta.process(principal(deviceA), { storeId, accountId }, {
      mutations: [{
        mutation_id: ulid(), entity_type: 'supplier', action: 'update',
        payload: { guuid: uuid(), name: 'No Version' },
      }],
    });
    expect(res.mutation_results[0]).toMatchObject({
      status: 'rejected',
      code: 'SYNC_MISSING_ROW_VERSION',
      conflict_type: 'VALIDATION',
    });
  });

  it('unknown entity_type → rejected UNKNOWN_MUTATION (the #1 PRD gap made explicit)', async () => {
    const res = await delta.process(principal(deviceA), { storeId, accountId }, {
      mutations: [{
        mutation_id: ulid(), entity_type: 'order', action: 'create',
        payload: { guuid: uuid() },
      }],
    });
    expect(res.mutation_results[0]).toMatchObject({ status: 'rejected', code: 'UNKNOWN_MUTATION' });
  });

  it('delete writes a same-tx tombstone and device B receives it as a delete (§8)', async () => {
    const cursorB0 = await coldStart(deviceB);
    const guuid = uuid();

    await delta.process(principal(deviceA), { storeId, accountId }, {
      mutations: [{
        mutation_id: ulid(), entity_type: 'product', action: 'create',
        payload: { guuid, name: 'Ephemeral Item', selling_price: 10 },
      }],
    });
    await delta.process(principal(deviceA), { storeId, accountId }, {
      mutations: [{
        mutation_id: ulid(), entity_type: 'product', action: 'delete',
        payload: { guuid },
      }],
    });

    const trows = await db.select().from(syncTombstones);
    expect(trows.some((t) => t.entityGuuid === guuid && t.entityType === 'product')).toBe(true);

    await outwaitLag();
    const pulled = await changes.pull(userId, storeId, cursorB0);
    const deletes = pulled.changes.product?.deletes ?? [];
    expect(deletes.some((d) => d.guuid === guuid)).toBe(true);
    // Created + deleted in one window: the upsert filter excludes soft-deleted
    // rows, so the row arrives ONLY as a delete — it must end deleted (BR-SYNC-021).
    const upserts = pulled.changes.product?.upserts ?? [];
    expect(upserts.some((u) => u.guuid === guuid)).toBe(false);
  });

  it('a failed parent cascades PARENT_FAILED to its children, sorted regardless of batch order (S-3)', async () => {
    const parentGuuid = uuid();
    const childGuuid = uuid();

    const res = await delta.process(principal(deviceA), { storeId, accountId }, {
      mutations: [
        // Child FIRST in the batch — the dependency sort must still run the parent first.
        {
          mutation_id: ulid(), entity_type: 'product_case', action: 'create',
          parent_guuid: parentGuuid,
          payload: { guuid: childGuuid, product_guuid: parentGuuid, name: 'Box of 12', quantity: 12 },
        },
        {
          mutation_id: ulid(), entity_type: 'product', action: 'create',
          payload: { guuid: parentGuuid, name: '' /* fails min-length validation */, selling_price: 5 },
        },
      ],
    });

    const byStatus = Object.fromEntries(res.mutation_results.map((r) => [r.mutation_id, r]));
    const parentResult = res.mutation_results.find((r) => r.status === 'rejected' && (r as { code: string }).code === 'VALIDATION_FAILED');
    const childResult = res.mutation_results.find((r) => (r as { code?: string }).code === 'PARENT_FAILED');
    expect(parentResult).toBeDefined();
    expect(childResult).toBeDefined();
    expect(Object.keys(byStatus)).toHaveLength(2);
  });

  it('advances watermarks no-gap: a second pull with the new cursor re-delivers nothing (§7)', async () => {
    const cursorB0 = await coldStart(deviceB);
    await delta.process(principal(deviceA), { storeId, accountId }, {
      mutations: [{
        mutation_id: ulid(), entity_type: 'customer', action: 'create',
        payload: { guuid: uuid(), name: 'One-Time Customer' },
      }],
    });

    await outwaitLag();
    const first = await changes.pull(userId, storeId, cursorB0);
    expect(first.changes.customer?.upserts ?? []).toHaveLength(1);

    const second = await changes.pull(userId, storeId, first.sync_cursor);
    expect(second.changes.customer?.upserts ?? []).toHaveLength(0);
    expect(second.has_more).toBe(false);
  });
});