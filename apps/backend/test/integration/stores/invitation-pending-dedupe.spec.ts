import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { DRIZZLE, DbModule, type Database } from '../../../src/db/db.module';
import { InvitationRepository } from '../../../src/stores/invitation/invitation.repository';
import {
  accounts,
  users,
  stores,
  roles,
  invitations,
} from '../../../src/db/schema';

/**
 * Regression coverage for the invitation-dedupe TOCTOU fix (backend-standard
 * review, §3/§9): "one pending invite per contact+role+store" used to be an
 * app-only pre-check with no DB backstop, so two concurrent creates could
 * both pass it and insert duplicate pending rows. uk_invitations_pending_phone
 * / uk_invitations_pending_email now enforce it at the DB, and
 * expireStalePending sweeps naturally-lapsed pending rows first so the
 * constraint never blocks a legitimate re-invite of a contact whose old
 * invite quietly expired (nothing else transitions status to 'expired').
 */
describe('Invitations — pending-dedupe constraint', () => {
  let db: Database;
  let repo: InvitationRepository;

  let userId: string;
  let storeId: string;
  let roleAId: string;
  let roleBId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule],
      providers: [InvitationRepository],
    }).compile();
    db = moduleRef.get(DRIZZLE);
    repo = moduleRef.get(InvitationRepository);
  });

  beforeEach(async () => {
    await db.delete(invitations);
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
      .values({ name: 'Inviter', phone: `+1${Math.floor(Math.random() * 1e9)}` })
      .returning();
    userId = user!.id;
    const [store] = await db
      .insert(stores)
      .values({ accountFk: account!.id, name: 'Store' })
      .returning();
    storeId = store!.id;

    const insertedRoles = await db
      .insert(roles)
      .values([
        { storeFk: storeId, code: 'CASHIER', name: 'Cashier' },
        { storeFk: storeId, code: 'MANAGER', name: 'Manager' },
      ])
      .returning();
    roleAId = insertedRoles.find((r) => r.code === 'CASHIER')!.id;
    roleBId = insertedRoles.find((r) => r.code === 'MANAGER')!.id;
  });

  function invite(overrides: Partial<typeof invitations.$inferInsert> = {}) {
    return {
      storeFk: storeId,
      roleFk: roleAId,
      phone: '+19999999999',
      token: `tok-${Date.now()}-${Math.random()}`,
      invitedBy: userId,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      ...overrides,
    };
  }

  it('rejects a second live pending invite for the same store+role+phone', async () => {
    await repo.create(invite());
    await expect(repo.create(invite())).rejects.toBeInstanceOf(postgres.PostgresError);
  });

  it('allows the same phone under a different role', async () => {
    await repo.create(invite({ roleFk: roleAId }));
    await expect(repo.create(invite({ roleFk: roleBId }))).resolves.toBeDefined();
  });

  it('allows the same phone+role once the prior invite is no longer pending', async () => {
    const first = await repo.create(invite());
    await db.update(invitations).set({ status: 'accepted' }).where(eq(invitations.id, first.id));

    await expect(repo.create(invite())).resolves.toBeDefined();
  });

  it('expireStalePending flips a lapsed pending row so a re-invite is not blocked', async () => {
    const first = await repo.create(invite({ expiresAt: new Date(Date.now() - 1000) }));

    // Without the sweep, this would violate uk_invitations_pending_phone.
    await repo.expireStalePending(storeId, roleAId, '+19999999999', undefined, db);

    const second = await repo.create(invite());
    expect(second.id).not.toBe(first.id);

    const [firstRow] = await db
      .select({ status: invitations.status })
      .from(invitations)
      .where(eq(invitations.id, first.id));
    expect(firstRow?.status).toBe('expired');
  });

  it('expireStalePending leaves a live (non-expired) pending row untouched', async () => {
    const live = await repo.create(invite());
    await repo.expireStalePending(storeId, roleAId, '+19999999999', undefined, db);

    // The live row is still 'pending', so a second create still collides.
    await expect(repo.create(invite())).rejects.toBeInstanceOf(postgres.PostgresError);

    const [row] = await db
      .select({ status: invitations.status })
      .from(invitations)
      .where(eq(invitations.id, live.id));
    expect(row?.status).toBe('pending');
  });
});