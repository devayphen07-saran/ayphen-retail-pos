/**
 * db:seed — inserts reference / master data into a freshly migrated database.
 * Safe to re-run: uses onConflictDoUpdate so it is idempotent.
 *
 * Seeds:
 *   - system-wide roles (USER, SUPER_ADMIN — immutable, store_fk NULL) (rbac.md §4)
 *   - subscription plans (+ entitlements + features); 'free' is the trial plan
 *   - sequences (order, refund, adjustment)
 *
 * STORE_OWNER is NOT seeded here: it is a system role but store-scoped
 * (store_fk set), created per store by the store-creation flow.
 * Account ownership is accounts.owner_user_fk, not a role — nothing to seed.
 *
 * Usage:  pnpm db:seed
 * Full reset:  pnpm db:flush && pnpm db:seed
 */
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema.js';
import { ENTITIES } from '../../common/rbac/permission-matrix.constants.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[seed] DATABASE_URL is not set');
  process.exit(1);
}

const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });

// ─── System roles ─────────────────────────────────────────────────────────────
// Immutable (isEditable=false), system-wide (storeFk=NULL). Custom roles
// (manager/cashier/accountant) are store-scoped and seeded per store from
// DEFAULT_ROLE_CRUD when an owner creates them (rbac.md §4, §9).

const SYSTEM_ROLES = [
  { code: 'USER', name: 'User' },
  { code: 'SUPER_ADMIN', name: 'Super Admin' },
] as const;

// ─── Subscription plans ─────────────────────────────────────────────────────────
// 'free' is the plan every new signup starts on (15-day trial). Entitlement
// value null = unlimited (rbac.md §26.6). Features default off unless listed true.

const PLANS = [
  {
    name: 'free',
    displayName: 'Free',
    entitlements: {
      max_stores:              1,
      max_locations_per_store: 1,
      max_devices_per_store:   2,
      max_users_per_store:     3,
      max_products:            100,
    },
    features: {
      barcode_scanning: false,
      multi_store:      false,
      advanced_reports: false,
      offline_mode:     true,
    },
  },
  {
    name: 'starter',
    displayName: 'Starter',
    entitlements: {
      max_stores:              1,
      max_locations_per_store: 3,
      max_devices_per_store:   5,
      max_users_per_store:     10,
      max_products:            2000,
    },
    features: {
      barcode_scanning: true,
      multi_store:      false,
      advanced_reports: false,
      offline_mode:     true,
    },
  },
  {
    name: 'growth',
    displayName: 'Growth',
    entitlements: {
      max_stores:              null,  // unlimited
      max_locations_per_store: null,
      max_devices_per_store:   20,
      max_users_per_store:     null,
      max_products:            null,
    },
    features: {
      barcode_scanning: true,
      multi_store:      true,
      advanced_reports: true,
      offline_mode:     true,
    },
  },
] as const;

// ─── Sequences ────────────────────────────────────────────────────────────────

const SEQUENCES = [
  { type: 'order', prefix: 'ORD', counter: 0, year: new Date().getFullYear() },
  { type: 'refund', prefix: 'REF', counter: 0, year: new Date().getFullYear() },
  {
    type: 'adjustment',
    prefix: 'ADJ',
    counter: 0,
    year: new Date().getFullYear(),
  },
] as const;

// ─── Runner ───────────────────────────────────────────────────────────────────

async function seed() {
  console.log('[seed] Seeding system roles...');
  for (const role of SYSTEM_ROLES) {
    await db
      .insert(schema.roles)
      .values({
        code: role.code,
        name: role.name,
        isEditable: false,
        storeFk: null,
      })
      .onConflictDoNothing();
  }
  console.log(`[seed] ${SYSTEM_ROLES.length} system roles seeded.`);

  console.log('[seed] Seeding plans...');
  for (const plan of PLANS) {
    await db
      .insert(schema.plans)
      .values({ name: plan.name, displayName: plan.displayName, isActive: true })
      .onConflictDoNothing({ target: schema.plans.name });

    const [row] = await db
      .select({ id: schema.plans.id })
      .from(schema.plans)
      .where(eq(schema.plans.name, plan.name));
    if (!row) continue;

    for (const [key, value] of Object.entries(plan.entitlements)) {
      await db
        .insert(schema.planEntitlements)
        .values({ planFk: row.id, key, value })
        .onConflictDoUpdate({
          target: [schema.planEntitlements.planFk, schema.planEntitlements.key],
          set: { value },
        });
    }
    for (const [key, enabled] of Object.entries(plan.features)) {
      await db
        .insert(schema.planFeatures)
        .values({ planFk: row.id, key, enabled })
        .onConflictDoUpdate({
          target: [schema.planFeatures.planFk, schema.planFeatures.key],
          set: { enabled },
        });
    }
  }
  console.log(`[seed] ${PLANS.length} plans seeded.`);

  console.log('[seed] Seeding entity types...');
  for (const entity of ENTITIES) {
    await db
      .insert(schema.entityTypes)
      .values({
        code:                entity.code,
        label:               entity.label,
        isOfflineSafe:       entity.isOfflineSafe,
        supportsAttachments: entity.supportsAttachments,
      })
      .onConflictDoUpdate({
        target: schema.entityTypes.code,
        set: {
          label:               entity.label,
          isOfflineSafe:       entity.isOfflineSafe,
          supportsAttachments: entity.supportsAttachments,
        },
      });
  }
  console.log(`[seed] ${ENTITIES.length} entity types seeded.`);

  console.log('[seed] Seeding sequences...');
  for (const seq of SEQUENCES) {
    await db
      .insert(schema.sequences)
      .values(seq)
      .onConflictDoUpdate({
        target: schema.sequences.type,
        set: { prefix: seq.prefix, year: seq.year },
      });
  }
  console.log(`[seed] ${SEQUENCES.length} sequences seeded.`);

  console.log('[seed] Done.');
  await client.end();
}

seed().catch((err) => {
  console.error('[seed] Failed:', err);
  process.exit(1);
});
