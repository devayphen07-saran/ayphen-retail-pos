import { Test } from '@nestjs/testing';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, DbModule, type Database } from '../../../src/db/db.module';
import { InvitationRepository } from '../../../src/stores/invitation.repository';
import {
  accounts,
  users,
  stores,
  locations,
  roles,
  invitations,
  invitationLocations,
  userLocationMappings,
} from '../../../src/db/schema';

/**
 * Location-scoped invitations: an invite grants a custom role scoped to a set
 * of locations, and accepting it must assign the invitee to exactly those
 * locations (the "WHERE" gate). These repository methods are the new wiring
 * for that — tested directly against the DB.
 */
describe('InvitationRepository — location scoping', () => {
  let db: Database;
  let repo: InvitationRepository;

  let userId: string;
  let storeId: string;
  let otherStoreId: string;
  let roleId: string;
  let locActive1: string;
  let locActive2: string;
  let locInactive: string;
  let locOtherStore: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule],
      providers: [InvitationRepository],
    }).compile();
    db = moduleRef.get(DRIZZLE);
    repo = moduleRef.get(InvitationRepository);
  });

  beforeEach(async () => {
    await db.delete(userLocationMappings);
    await db.delete(invitationLocations);
    await db.delete(invitations);
    await db.delete(locations);
    await db.delete(roles);
    await db.delete(stores);
    await db.delete(users);
    await db.delete(accounts);

    const [account] = await db
      .insert(accounts)
      .values({ accountNumber: `ACC-${Date.now()}-${Math.random()}`, name: 'Acct' })
      .returning();

    const [user] = await db
      .insert(users)
      .values({ name: 'Invitee', phone: `+1${Math.floor(Math.random() * 1e9)}` })
      .returning();
    userId = user!.id;

    const [store] = await db
      .insert(stores)
      .values({ accountFk: account!.id, name: 'Main Store' })
      .returning();
    storeId = store!.id;

    const [other] = await db
      .insert(stores)
      .values({ accountFk: account!.id, name: 'Other Store' })
      .returning();
    otherStoreId = other!.id;

    const [role] = await db
      .insert(roles)
      .values({ storeFk: storeId, code: 'CASHIER', name: 'Cashier' })
      .returning();
    roleId = role!.id;

    const inserted = await db
      .insert(locations)
      .values([
        { storeFk: storeId, name: 'Front Desk', isActive: true },
        { storeFk: storeId, name: 'Warehouse', isActive: true },
        { storeFk: storeId, name: 'Closed Branch', isActive: false },
        { storeFk: otherStoreId, name: 'Foreign Loc', isActive: true },
      ])
      .returning();
    locActive1 = inserted.find((l) => l.name === 'Front Desk')!.id;
    locActive2 = inserted.find((l) => l.name === 'Warehouse')!.id;
    locInactive = inserted.find((l) => l.name === 'Closed Branch')!.id;
    locOtherStore = inserted.find((l) => l.name === 'Foreign Loc')!.id;
  });

  async function makeInvitation(): Promise<string> {
    const [row] = await db
      .insert(invitations)
      .values({
        storeFk: storeId,
        roleFk: roleId,
        phone: '+10000000000',
        token: `tok-${Date.now()}-${Math.random()}`,
        invitedBy: userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    return row!.id;
  }

  it('filterStoreLocationIds accepts only active locations of the store', async () => {
    const valid = await repo.filterStoreLocationIds(storeId, [locActive1, locActive2]);
    expect(new Set(valid)).toEqual(new Set([locActive1, locActive2]));

    // Inactive and foreign-store ids are dropped — the service compares length
    // to reject the whole request as UNKNOWN_LOCATION.
    const filtered = await repo.filterStoreLocationIds(storeId, [
      locActive1,
      locInactive,
      locOtherStore,
    ]);
    expect(filtered).toEqual([locActive1]);
  });

  it('insertInvitationLocations + listInvitationLocationIds round-trip', async () => {
    const invitationId = await makeInvitation();
    await repo.insertInvitationLocations(invitationId, [locActive1, locActive2]);

    const ids = await repo.listInvitationLocationIds(invitationId);
    expect(new Set(ids)).toEqual(new Set([locActive1, locActive2]));

    // Idempotent — re-inserting the same set doesn't duplicate or throw.
    await repo.insertInvitationLocations(invitationId, [locActive1, locActive2]);
    const again = await repo.listInvitationLocationIds(invitationId);
    expect(again).toHaveLength(2);
  });

  it('assignLocations inserts mappings and reactivates a soft-revoked one', async () => {
    await repo.assignLocations(userId, [locActive1, locActive2], userId);

    const active = async () =>
      db
        .select({ locationFk: userLocationMappings.locationFk })
        .from(userLocationMappings)
        .where(and(eq(userLocationMappings.userFk, userId), isNull(userLocationMappings.revokedAt)));

    expect(new Set((await active()).map((r) => r.locationFk))).toEqual(
      new Set([locActive1, locActive2]),
    );

    // Soft-revoke one, then re-assign — the row is reactivated, not duplicated.
    await db
      .update(userLocationMappings)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(userLocationMappings.userFk, userId), eq(userLocationMappings.locationFk, locActive1)),
      );
    await repo.assignLocations(userId, [locActive1], userId);

    const rows = await active();
    expect(new Set(rows.map((r) => r.locationFk))).toEqual(new Set([locActive1, locActive2]));
  });
});
