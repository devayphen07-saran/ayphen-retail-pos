import {
  pgTable,
  text,
  varchar,
  uuid,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  unique,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { primaryKey, numeric } from 'drizzle-orm/pg-core';
import { auditColumns } from './audit';
import { syncColumns } from './sync-columns';

// ─── Accounts ─────────────────────────────────────────────────────────────────
// Top-level billing/tenant entity. Each account owns one or more stores.

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountNumber: text('account_number').notNull().unique(),
    name: text('name').notNull(),
    // The user who owns this account. Account-wide authority (manage subscription,
    // create stores, transfer/delete account) is a direct ownership check against
    // this column — NOT an RBAC role. Store authority lives in userRoleMappings.
    ownerUserFk: uuid('owner_user_fk').references(() => users.id),
    gstNumber: text('gst_number'), // §26.4
    billingAddress: jsonb('billing_address'), // §26.4
    razorpayCustomerId: text('razorpay_customer_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_accounts_owner').on(t.ownerUserFk)],
);

// ─── Plans ────────────────────────────────────────────────────────────────────

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(), // 'starter' | 'growth' | 'enterprise'
  displayName: text('display_name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── Plan Entitlements (numeric limits) ───────────────────────────────────────
// value = null means unlimited

export const planEntitlements = pgTable(
  'plan_entitlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planFk: uuid('plan_fk')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    key: text('key').notNull(), // 'max_stores' | 'max_devices_per_store' | 'max_products' …
    value: integer('value'), // null = unlimited
  },
  (t) => [uniqueIndex('plan_entitlements_plan_key_uq').on(t.planFk, t.key)],
);

// ─── Plan Features (boolean capabilities) ────────────────────────────────────

export const planFeatures = pgTable(
  'plan_features',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planFk: uuid('plan_fk')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    key: text('key').notNull(), // 'barcode_scanning' | 'advanced_reports' | 'api_access' …
    enabled: boolean('enabled').notNull().default(false),
  },
  (t) => [uniqueIndex('plan_features_plan_key_uq').on(t.planFk, t.key)],
);

// ─── Stores ──────────────────────────────────────────────────────────────────

export const stores = pgTable(
  'stores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Sync key + delta watermark (sync-engine.md §3 order 0). The store row is
    // pulled, never pushed — no row_version. modified_at is trigger-maintained.
    guuid: uuid('guuid').notNull().defaultRandom().unique(),
    modifiedAt: timestamp('modified_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    accountFk: uuid('account_fk')
      .notNull()
      .references(() => accounts.id),
    name: text('name').notNull(),
    gstNumber: text('gst_number'),
    address: text('address'),
    phone: text('phone'),
    email: text('email'),
    invoicePrefix: text('invoice_prefix').notNull().default('INV'),
    invoiceCounter: integer('invoice_counter').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    locked: boolean('locked').notNull().default(false),
    lockedReason: text('locked_reason', { enum: ['downgrade'] }),
    ...auditColumns,
  },
  (t) => [index('idx_stores_account').on(t.accountFk)],
);

// ─── Users ───────────────────────────────────────────────────────────────────
// A user must be reachable by at least one channel — enforced by the
// users_email_or_phone CHECK below (email/phone each nullable, but not both).

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guuid: uuid('guuid').notNull().defaultRandom(),
    email: text('email').unique(),
    phone: text('phone').unique(),
    name: text('name').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    phoneVerified: boolean('phone_verified').notNull().default(false),
    primaryLoginMethod: text('primary_login_method', {
      enum: ['otp', 'password', 'google'],
    })
      .notNull()
      .default('otp'),
    permissionsVersion: integer('permissions_version').notNull().default(1),
    status: text('status', {
      enum: ['active', 'suspended', 'locked'],
    })
      .notNull()
      .default('active'),
    // null until the user picks one on the mode-chooser screen (mobile-03 §3c/3d).
    lastAccountMode: text('last_account_mode', {
      enum: ['business', 'personal'],
    }),
    isBlocked: boolean('is_blocked').notNull().default(false),
    blockedReason: text('blocked_reason'),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    accountLockedUntil: timestamp('account_locked_until', {
      withTimezone: true,
    }),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    imageAttachmentFk: uuid('image_attachment_fk'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Staff-sync delta watermark (sync-engine.md §3 order 8). Bumped by the
    // sync_touch trigger only when sync-relevant columns change (see the trigger's
    // WHEN clause) — lastLoginAt churn must not re-deliver every staff row.
    modifiedAt: timestamp('modified_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'users_email_or_phone',
      sql`${t.email} IS NOT NULL OR ${t.phone} IS NOT NULL`,
    ),
    // guuid is the client-facing sync key — must be unique to upsert by.
    uniqueIndex('users_guuid_uq').on(t.guuid),
    // Staff delta-sync keyset (modified_at, id) — without this the staff pull
    // seq-scans users as the user base grows.
    index('idx_users_modified').on(t.modifiedAt, t.id),
  ],
);

// ─── Account ↔ Users (many-to-many, role scoped) ──────────────────────────────

// Pure account membership (which users belong to which account). Authority —
// including account ownership — is a role in userRoleMappings, never a flag here.
// ACCOUNT_OWNER (system role, store_fk NULL) = owns the account/billing;
// STORE_OWNER (system role, store_fk set) = owns a specific store (§4, §26.4).
export const accountUsers = pgTable(
  'account_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountFk: uuid('account_fk')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userFk: uuid('user_fk')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('account_users_account_user_uq').on(t.accountFk, t.userFk),
    index('idx_account_users_user').on(t.userFk), // §26.15
  ],
);

// ─── Roles (RBAC) ──────────────────────────────────────────────────────────────
// storeFk NULL = system-wide role (USER, SUPER_ADMIN — immutable). STORE_OWNER
// is the one system role that IS store-scoped (one per store, immutable, created
// in the store-create txn). Custom roles always have storeFk NOT NULL. A CHECK
// constraint prevents a store-scoped role from masquerading as a system-wide
// role code (§4, §19). Account ownership is NOT a role — it is accounts.ownerUserFk.

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeFk: uuid('store_fk').references(() => stores.id), // NULL for system roles
    code: text('code').notNull(), // 'STORE_OWNER', 'CASHIER', …
    name: text('name').notNull(), // human label ("Head Cashier")
    description: text('description'),
    isEditable: boolean('is_editable').notNull().default(true), // false for system roles
    // Optimistic-lock guard on permission edits — RoleService.updatePermissions
    // checks-and-bumps this atomically in the UPDATE's WHERE clause, so two
    // admins editing the same role's full permission matrix concurrently get
    // a conflict signal instead of a silent last-write-wins clobber.
    rowVersion: integer('row_version').notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    // System-wide roles (USER, SUPER_ADMIN) must have store_fk NULL.
    // STORE_OWNER is exempt: it is a system role but store-scoped (one per store).
    check(
      'system_role_no_store',
      sql`${t.storeFk} IS NULL OR ${t.code} NOT IN ('SUPER_ADMIN', 'USER')`,
    ),
    // A custom (editable) role can never carry a reserved system code — the
    // app-level check in RoleService.createRole is a fast pre-check; this is
    // the actual backstop, since consumers like the store-owner bypass checks
    // trust roles.code === 'STORE_OWNER' unconditionally with no isEditable
    // check of their own.
    check(
      'roles_no_reserved_code_when_editable',
      sql`NOT (${t.isEditable} AND ${t.code} IN ('STORE_OWNER', 'SUPER_ADMIN', 'USER'))`,
    ),
    // System-wide roles (storeFk NULL) are unique by code; custom roles may reuse
    // codes across stores. Also gives seed onConflictDoNothing a stable target.
    uniqueIndex('roles_system_code_uq')
      .on(t.code)
      .where(sql`${t.storeFk} IS NULL`),
    // One role name per store (custom roles); scoped so different stores may reuse names.
    uniqueIndex('roles_store_name_uq').on(t.storeFk, t.name),
    // "One STORE_OWNER per store" was previously an app-only invariant (only
    // StoreService.createStore's single insert path relied on). Backed here
    // so a future direct insert can't create a second owner role for a store.
    uniqueIndex('roles_one_owner_per_store_uq')
      .on(t.storeFk, t.code)
      .where(sql`${t.code} = 'STORE_OWNER'`),
    index('idx_roles_store').on(t.storeFk),
  ],
);

// CRUD grants — one row per (role, entity, action). Soft-deleted via revokedAt
// so point-in-time authorization (§17) can ask "was this granted at time T?".
export const rolePermissions = pgTable(
  'role_permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roleFk: uuid('role_fk')
      .notNull()
      .references(() => roles.id),
    entityCode: text('entity_code').notNull(), // PascalCase, e.g. 'Order'
    action: text('action', {
      enum: ['view', 'create', 'edit', 'delete'],
    }).notNull(),
    grantedBy: uuid('granted_by').references(() => users.id),
    grantedAt: timestamp('granted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }), // NULL = active grant
  },
  (t) => [
    // Partial — scoped to ACTIVE grants only. Non-partial would collide with
    // a grant's own revoked history row on re-grant (backend-standard review
    // finding): every custom role is seeded with active grants, and the very
    // first PATCH that retains one of them would try to insert a tuple that
    // already exists as a soft-deleted row. History rows must be free to
    // coexist with a fresh active grant of the same (role, entity, action).
    uniqueIndex('role_permissions_role_entity_action_uq')
      .on(t.roleFk, t.entityCode, t.action)
      .where(sql`${t.revokedAt} IS NULL`),
    index('idx_role_permissions_role').on(t.roleFk),
  ],
);

// Special (beyond-CRUD) action grants — REFUND, VOID, EXPORT, … (§7)
export const roleSpecialPermissions = pgTable(
  'role_special_permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roleFk: uuid('role_fk')
      .notNull()
      .references(() => roles.id),
    entityCode: text('entity_code').notNull(), // e.g. 'Order'
    actionCode: text('action_code').notNull(), // SCREAMING_SNAKE_CASE, e.g. 'REFUND'
    grantedBy: uuid('granted_by').references(() => users.id),
    grantedAt: timestamp('granted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    // Partial — same reasoning as role_permissions_role_entity_action_uq
    // above: this table is soft-deleted via revokedAt too, so a non-partial
    // index would identically block re-granting a previously-revoked special
    // permission.
    uniqueIndex('role_special_permissions_uq')
      .on(t.roleFk, t.entityCode, t.actionCode)
      .where(sql`${t.revokedAt} IS NULL`),
    index('idx_role_special_permissions_role').on(t.roleFk),
  ],
);

// User ↔ Role assignment (store-scoped). storeFk NULL = system-wide (e.g. SUPER_ADMIN).
export const userRoleMappings = pgTable(
  'user_role_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userFk: uuid('user_fk')
      .notNull()
      .references(() => users.id),
    roleFk: uuid('role_fk')
      .notNull()
      .references(() => roles.id),
    storeFk: uuid('store_fk').references(() => stores.id), // NULL for system-wide roles
    assignedBy: uuid('assigned_by').references(() => users.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }), // soft-delete
    expiresAt: timestamp('expires_at', { withTimezone: true }), // optional temporary assignment
  },
  (t) => [
    uniqueIndex('user_role_mappings_uq').on(t.userFk, t.roleFk, t.storeFk),
    index('idx_user_role_mappings_user_store').on(t.userFk, t.storeFk),
    index('idx_user_role_mappings_role').on(t.roleFk),
    // storeFk-leading lookup for the staff-sync membership join (store filter).
    index('idx_user_role_mappings_store').on(t.storeFk),
  ],
);

// Staff invitations — invite a phone/email to a store with a custom role.
// Only custom roles are assignable via invitation (rbac.md §4, BR-RBAC-006).
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeFk: uuid('store_fk')
      .notNull()
      .references(() => stores.id),
    roleFk: uuid('role_fk')
      .notNull()
      .references(() => roles.id),
    phone: text('phone'),
    email: text('email'),
    token: text('token').notNull().unique(), // SHA-256 hash of the accept token
    status: text('status', {
      enum: ['pending', 'accepted', 'revoked', 'expired'],
    })
      .notNull()
      .default('pending'),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    acceptedBy: uuid('accepted_by').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_invitations_store').on(t.storeFk),
    index('idx_invitations_phone').on(t.phone),
    index('idx_invitations_status').on(t.status),
    index('idx_invitations_role').on(t.roleFk),
    // Backstops InvitationService.create's "one pending invite per contact +
    // role" pre-check (TOCTOU-able by itself, same shape as roles_store_name_uq
    // elsewhere in this schema). Two separate indexes, not
    // one compound (store_fk, role_fk, phone, email) index, because the app
    // check is an OR across phone/email, not an AND — and Postgres unique
    // indexes never treat two NULLs as equal, so a phone-only invite's NULL
    // email would never collide with anything under a combined index anyway.
    // Scoped to status='pending' only (not also expiresAt > now(), which a
    // partial index predicate can't express — `now()` isn't immutable) —
    // InvitationService.create sweeps stale-expired pending rows to status=
    // 'expired' under the same lock before insert, so this constraint only
    // ever sees genuinely live duplicates.
    uniqueIndex('uk_invitations_pending_phone')
      .on(t.storeFk, t.roleFk, t.phone)
      .where(sql`${t.status} = 'pending' AND ${t.phone} IS NOT NULL`),
    uniqueIndex('uk_invitations_pending_email')
      .on(t.storeFk, t.roleFk, t.email)
      .where(sql`${t.status} = 'pending' AND ${t.email} IS NOT NULL`),
  ],
);

// Entity registry — drives the offline snapshot allow-list and attachment support (§5).
export const entityTypes = pgTable('entity_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(), // 'Product', 'Order', …
  label: text('label').notNull(), // 'Products', 'Orders', …
  isOfflineSafe: boolean('is_offline_safe').notNull().default(false),
  supportsAttachments: boolean('supports_attachments').notNull().default(false),
});

// ─── Account Subscriptions ────────────────────────────────────────────────────
// One subscription per account (UNIQUE on account_fk).

export const accountSubscriptions = pgTable(
  'account_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountFk: uuid('account_fk')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    planFk: uuid('plan_fk')
      .notNull()
      .references(() => plans.id),
    // Billing cadence (e.g. 'starter_monthly' vs 'starter_annual') — keys into
    // PLAN_PRICING. planFk alone only identifies the plan *name*, not which
    // priced variant was purchased. Null pre-checkout (trialing on the free plan).
    planCode: text('plan_code'),
    status: text('status', {
      enum: [
        'trialing',
        'active',
        'past_due',
        'paused',
        'cancelled',
        'expired',
      ],
    })
      .notNull()
      .default('trialing'),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    currentPeriodStart: timestamp('current_period_start', {
      withTimezone: true,
    }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    pastDueGraceUntil: timestamp('past_due_grace_until', {
      withTimezone: true,
    }),
    // Computed and stored: max(currentPeriodEnd, pastDueGraceUntil, trialEndsAt).
    // SubscriptionStatusGuard reads this column — never derive at query time.
    accessValidUntil: timestamp('access_valid_until', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    subscriptionVersion: integer('subscription_version').notNull().default(1),
    hasUsedTrial: boolean('has_used_trial').notNull().default(false),
    razorpaySubId: text('razorpay_sub_id'),
    // Downgrade-reconciliation gate (subscription §15D/§27, device-management
    // §19/§27 D11-adjacent). 'pending' = a plan change left some resource
    // (stores/devices) over its new limit; ALL writes are blocked
    // account-wide until the owner resolves which to keep (never auto-picked).
    // 'applied' = resolved; excess locked/revoked. reconciliationEffectiveAt is
    // the point-in-time boundary sync uses to accept offline writes made before
    // the downgrade took effect — mirrors accessValidUntil's role for expiry.
    reconciliationStatus: text('reconciliation_status', {
      enum: ['none', 'pending', 'applied'],
    })
      .notNull()
      .default('none'),
    reconciliationEffectiveAt: timestamp('reconciliation_effective_at', {
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('account_subscriptions_account_uq').on(t.accountFk),
    index('idx_account_subscriptions_plan').on(t.planFk),
    // Each partial index backs one of SubscriptionLifecycleCronService's four
    // `UPDATE ... WHERE status = X AND <date column> < now()` sweeps, run
    // every tick — without these the scan cost grows with total account count.
    index('idx_accsub_trialing')
      .on(t.trialEndsAt)
      .where(sql`${t.status} = 'trialing'`),
    index('idx_accsub_active_period_end')
      .on(t.currentPeriodEnd)
      .where(sql`${t.status} = 'active' AND ${t.cancelAtPeriodEnd} = false`),
    index('idx_accsub_cancel_period_end')
      .on(t.currentPeriodEnd)
      .where(sql`${t.status} = 'active' AND ${t.cancelAtPeriodEnd} = true`),
    index('idx_accsub_pastdue_grace')
      .on(t.pastDueGraceUntil)
      .where(sql`${t.status} = 'past_due'`),
    check(
      'access_valid_until_required',
      sql`${t.accessValidUntil} IS NOT NULL OR ${t.status} = 'trialing'`,
    ),
  ],
);

// ─── Subscription audit outbox (subscription §29.14 / §38) ────────────────────
// Critical billing events (activate, past_due, cancel, reactivate, plan change,
// trial-lapse) are written here inside the SAME transaction as the domain write,
// then drained to audit_logs by a background worker. This decouples request
// availability from the audit subsystem: if the domain txn commits, the audit
// row is guaranteed (same txn); if the drainer is down, the row survives and
// retries. processed_at IS NULL = pending.

export const subscriptionAuditOutbox = pgTable(
  'subscription_audit_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountFk: uuid('account_fk')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(), // 'SUBSCRIPTION_ACTIVATED' | 'SUBSCRIPTION_PAST_DUE' | …
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }), // null = pending
    attempts: integer('attempts').notNull().default(0), // drain retry count
    deadLetteredAt: timestamp('dead_lettered_at', { withTimezone: true }), // stamped when a poison row is given up on
  },
  (t) => [
    // Drainer scans pending rows oldest-first; partial index keeps it cheap.
    index('idx_sub_outbox_pending')
      .on(t.createdAt)
      .where(sql`${t.processedAt} IS NULL`),
  ],
);

/**
 * Transactional idempotency guard for payment-activation (subscription §9/§19).
 * `providerRef` (the Razorpay payment id) is the primary key — the INSERT that
 * backs `BillingService.applySuccess` runs `ON CONFLICT DO NOTHING` in the SAME
 * transaction as the subscription UPDATE, so the "already processed" claim and
 * the activation effect can never drift apart (unlike the Redis `pay:done:*`
 * flag, which is only a fast-path pre-check ahead of this).
 */
export const processedPaymentEvents = pgTable('processed_payment_events', {
  providerRef: text('provider_ref').primaryKey(),
  accountFk: uuid('account_fk')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  orderId: text('order_id').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Durable pending-order mapping for checkout → verify/webhook (subscription
 * §9). `BillingService.checkout` writes the account/plan this order was
 * created for here (not just to Redis's `pay:order:{orderId}`, which has a
 * 1h TTL) — a payment webhook can legitimately arrive well after that window
 * (provider redelivery), and without a durable copy the activation has no
 * data to act on even though `processed_payment_events` could still accept
 * the claim. Rows are never updated; `applySuccess` only reads them.
 */
export const paymentOrders = pgTable(
  'payment_orders',
  {
    orderId: text('order_id').primaryKey(),
    accountFk: uuid('account_fk')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    planFk: uuid('plan_fk')
      .notNull()
      .references(() => plans.id),
    planCode: text('plan_code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_payment_orders_account').on(t.accountFk)],
);

// ─── Devices ─────────────────────────────────────────────────────────────────

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userFk: uuid('user_fk')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(),
    publicKeyHash: text('public_key_hash').notNull(),
    platform: text('platform', { enum: ['ios', 'android', 'web'] }).notNull(),
    model: text('model'),
    osVersion: text('os_version'),
    appVersion: text('app_version'),
    attestationVerified: boolean('attestation_verified')
      .notNull()
      .default(false),
    isTrusted: boolean('is_trusted').notNull().default(false),
    isBlocked: boolean('is_blocked').notNull().default(false),
    label: text('label'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastIp: text('last_ip'),
    pushToken: text('push_token'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('devices_user_key_hash_uq').on(t.userFk, t.publicKeyHash),
  ],
);

// ─── Device Sessions ──────────────────────────────────────────────────────────

export const deviceSessions = pgTable(
  'device_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userFk: uuid('user_fk')
      .notNull()
      .references(() => users.id),
    deviceFk: uuid('device_fk')
      .notNull()
      .references(() => devices.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastStepUpAt: timestamp('last_step_up_at', { withTimezone: true }),
    lastStepUpMethod: text('last_step_up_method', {
      enum: ['otp', 'password', 'biometric'],
    }),
    stepUpLockedUntil: timestamp('step_up_locked_until', {
      withTimezone: true,
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    currentJti: text('current_jti'),
    currentJtiExp: timestamp('current_jti_exp', { withTimezone: true }),
    ipAtCreation: text('ip_at_creation'),
    geoAtCreation: text('geo_at_creation'),
    deviceName: text('device_name'),
    os: text('os'),
    appVersion: text('app_version'),
    platform: text('platform'),
    lastAppVersion: text('last_app_version'),
    pushToken: text('push_token'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_device_sessions_user').on(t.userFk),
    index('idx_device_sessions_device').on(t.deviceFk),
  ],
);

// ─── Store Device Access (device-management §3.3) ─────────────────────────────
// The device↔store link that enforces max_devices_per_store. A "slot" is claimed
// when a device first accesses a store (F2). Registration (login) does NOT create
// a row. Exactly one active row per (store, device) — partial unique index. Slots
// free on owner-remove / block / 30-day expiry (status → revoked|expired).

export const storeDeviceAccess = pgTable(
  'store_device_access',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeFk: uuid('store_fk')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    deviceFk: uuid('device_fk')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    userFk: uuid('user_fk')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['active', 'revoked', 'expired'] })
      .notNull()
      .default('active'),
    deviceLabel: text('device_label'), // per-store label (F4)
    firstAccessedAt: timestamp('first_accessed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id),
    revokedReason: text('revoked_reason', {
      enum: [
        'owner_removed',
        'stolen',
        'auto_expired',
        'plan_downgrade',
        'released',
      ],
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    modifiedAt: timestamp('modified_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Sync key (sync-engine.md §3 order 2) — pulled so a device can see its own
    // and sibling slots offline; never pushed.
    guuid: uuid('guuid').notNull().defaultRandom().unique(),
  },
  (t) => [
    // One active slot per (store, device) — the concurrency guard for slot claims.
    uniqueIndex('uk_sda_active')
      .on(t.storeFk, t.deviceFk)
      .where(sql`${t.status} = 'active'`),
    index('idx_sda_store').on(t.storeFk),
    index('idx_sda_device').on(t.deviceFk),
    index('idx_sda_user').on(t.userFk),
  ],
);

// ─── Refresh Tokens ───────────────────────────────────────────────────────────

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceSessionFk: uuid('device_session_fk')
      .notNull()
      .references(() => deviceSessions.id),
    tokenHash: text('token_hash').notNull().unique(), // SHA-256 of raw token
    parentId: uuid('parent_id'), // self-ref — forms rotation chain
    familyId: uuid('family_id').notNull(), // groups all tokens in one rotation chain
    issuedAt: timestamp('issued_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }), // non-null = rotated; second use = reuse attack
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    uniqueIndex('refresh_tokens_token_hash_uq').on(t.tokenHash),
    index('idx_refresh_tokens_session').on(t.deviceSessionFk),
  ],
);

// ─── OTP Requests ─────────────────────────────────────────────────────────────

export const otpRequests = pgTable(
  'otp_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: text('phone').notNull(),
    purpose: text('purpose', {
      enum: ['login', 'signup', 'step_up'],
    }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_otp_requests_phone').on(t.phone)],
);

// ─── Revoked Tokens (JWT blacklist — persistent fallback behind Redis) ─────────

export const revokedTokens = pgTable(
  'revoked_tokens',
  {
    jti: text('jti').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Backs the retention cleanup's `WHERE expires_at < now()` — high write
    // volume (every logout + refresh rotation inserts a row) with no other
    // index on the table.
    index('idx_revoked_tokens_expires_at').on(t.expiresAt),
  ],
);

// ─── Sequences ────────────────────────────────────────────────────────────────
// One row per document type. Counter incremented inside a SELECT FOR UPDATE transaction.

export const sequences = pgTable('sequences', {
  type: text('type').primaryKey(), // 'order' | 'refund' | 'adjustment'
  prefix: text('prefix').notNull(), // 'ORD' | 'REF' | 'ADJ'
  counter: integer('counter').notNull().default(0),
  year: integer('year').notNull(), // resets to 0 on new calendar year
});

// ─── Login Attempts (rate limiting — IP / account / email / phone) ────────────

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ip: text('ip').notNull(),
    userId: uuid('user_id'),
    email: text('email'),
    phone: text('phone'),
    purpose: text('purpose').notNull(), // 'login' | 'otp' | 'signup'
    success: boolean('success').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Rate-limit lookups (rate-limit.repository.ts) — every one filters by a
    // key column plus a createdAt window, so createdAt trails each index.
    index('idx_login_attempts_ip_created').on(t.ip, t.createdAt),
    index('idx_login_attempts_phone_purpose_created').on(
      t.phone,
      t.purpose,
      t.createdAt,
    ),
    index('idx_login_attempts_email_created').on(t.email, t.createdAt),
    index('idx_login_attempts_user_created').on(t.userId, t.createdAt),
    // Backs the retention cleanup's bare `WHERE created_at < cutoff` scan —
    // none of the above indexes lead with createdAt.
    index('idx_login_attempts_created').on(t.createdAt),
  ],
);

// ─── Rate-limit fallback counters (Redis-outage degraded path only) ──────────

export const rateLimitFallbackCounters = pgTable(
  'rate_limit_fallback_counters',
  {
    // Same key format as the Redis path (e.g. 'rl:ip:1.2.3.4', 'rl:otp:+91...')
    // — one row per (key, fixed window bucket).
    key: text('key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.windowStart] }),
  ],
);

// ─── Auth Audit Logs (append-only — INSERT only, no UPDATE/DELETE) ───────────
// prefix + suffix + activityType allow UI to render human-readable sentences
// without knowing the event schema

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    event: text('event').notNull(),
    activityType: text('activity_type').notNull(),
    prefix: text('prefix').notNull(),
    suffix: text('suffix').notNull(),
    userId: uuid('user_id').notNull(),
    actorId: uuid('actor_id'),
    storeFk: uuid('store_fk'), // §20 — store scope for RBAC denials
    isSuccess: boolean('is_success').notNull().default(true), // false = denial (SOC2 CC6.3)
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    metadata: jsonb('metadata'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Covers per-user and per-store audit history lookups, newest first.
    index('idx_audit_logs_user_created').on(t.userId, t.createdAt),
    index('idx_audit_logs_store_created').on(t.storeFk, t.createdAt),
  ],
);

// ─── Reference Data — Country / Currency ───────────────────────────────────────
// Small, mostly-static master tables. Not lookup_type material (D1) — they
// carry extra structured columns (calling_code, symbol) beyond code/label —
// so they get real tables with a real DB FK, unlike lookup's polymorphic
// app-enforced pattern. Fills the country table table-architecture.md §34.2
// flagged as not yet existing (address.country_fk was a bare uuid until now).

export const country = pgTable('country', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 2 }).notNull().unique(), // ISO 3166-1 alpha-2
  name: varchar('name', { length: 100 }).notNull(),
  callingCode: varchar('calling_code', { length: 10 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const currency = pgTable('currency', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 3 }).notNull().unique(), // ISO 4217
  name: varchar('name', { length: 60 }).notNull(),
  symbol: varchar('symbol', { length: 10 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── Lookup Type / Lookup (lookup-entity-prd.md §3, D1–D5) ────────────────────
// Generic reference data for user-extensible, store-specific dropdown lists
// (PAYMENT_TERMS, CUSTOMER_TYPE, REASONS, …). NOT for logic-bearing states
// (order/payment status, supply_type, tracking_type, movement_type) — those
// stay `text` enums (D1: hybrid enum-vs-lookup — see the PRD's decision rule).
//
// No has_table/is_custom_table (D8) — we skip the dynamic-table engine;
// categories that need real columns become real tables directly (unit,
// tax_rate). guuid is the sync key (D5) — no separate numeric `key` column.

export const lookupType = pgTable('lookup_type', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 40 }).notNull().unique(), // 'PAYMENT_TERMS', 'REASONS', …
  title: varchar('title', { length: 80 }).notNull(),
  description: varchar('description', { length: 200 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const lookup = pgTable(
  'lookup',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guuid: uuid('guuid').notNull().defaultRandom().unique(), // sync key (D5)
    lookupTypeFk: uuid('lookup_type_fk')
      .notNull()
      .references(() => lookupType.id),
    storeFk: uuid('store_fk').references(() => stores.id), // null = global; set = store-custom (D4)
    code: varchar('code', { length: 40 }).notNull(),
    label: varchar('label', { length: 80 }).notNull(),
    description: varchar('description', { length: 200 }),
    sortOrder: integer('sort_order').notNull().default(0),
    isHidden: boolean('is_hidden').notNull().default(false),
    isSystem: boolean('is_system').notNull().default(false), // protected — reject edit/delete (BR-1)
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Sync: lookup is a writable synced entity (sync-engine.md §3 order 5) —
    // optimistic-lock version + trigger-maintained delta watermark. guuid above
    // predates the sync engine and already serves as the sync key (D5).
    rowVersion: integer('row_version').notNull().default(1),
    modifiedAt: timestamp('modified_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Per-type, not global (D3) — different lookup types may reuse the same code.
    uniqueIndex('uk_lookup_type_code').on(t.lookupTypeFk, t.code),
    // Delta-pull keyset (modified_at, id) — store filter is (null OR store_fk).
    index('idx_lookup_sync').on(t.modifiedAt, t.id),
    index('idx_lookup_type').on(t.lookupTypeFk),
    index('idx_lookup_store').on(t.storeFk),
    // Composite-FK target (D2, PRD §3.4/§11): a real UNIQUE CONSTRAINT (not
    // just an index) on (lookup_type_fk, id) so future referencing tables can
    // declare foreignKey({ columns: [xTypeFk, xFk], foreignColumns: [lookup.lookupTypeFk, lookup.id] })
    // — the DB then guarantees a value belongs to its expected type, which is
    // required since offline mutations sync in after an app-only guard could run.
    unique('uk_lookup_type_id').on(t.lookupTypeFk, t.id),
  ],
);

// ─── Files & Attachments — two-phase upload (table-architecture.md §33) ───────
// The client uploads to temporary_files (staging); on save the row is
// committed into files and linked to its parent entity. files_config sets
// per-entity limits enforced at upload time. Committed rows are polymorphic
// via entityTypeFk + recordGuuid (sync-safe) — recordId has no DB FK.

export const temporaryFiles = pgTable(
  'temporary_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guuid: uuid('guuid').notNull().defaultRandom().unique(),
    fileName: varchar('file_name', { length: 255 }).notNull(), // original filename
    storageKey: varchar('storage_key', { length: 1000 }).notNull(), // object-store key/path
    storageUrl: text('storage_url'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    sha256: varchar('sha256', { length: 64 }), // integrity / dedup
    uploadedBy: uuid('uploaded_by').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), // staging TTL — sweeper deletes uncommitted temps
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Atomic claim gate for FilesService.commit(): the commit path claims a
    // temp row with `UPDATE ... WHERE guuid = ? AND claimed_at IS NULL`
    // before the slow copy+transaction, so two concurrent commits of the
    // same upload can't both succeed (backend-standard review finding).
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    // Ephemeral — no soft-delete; unclaimed rows are purged after expiresAt.
  },
  (t) => [index('idx_temporary_files_expires_at').on(t.expiresAt)],
);

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guuid: uuid('guuid').notNull().defaultRandom().unique(),
    entityTypeFk: uuid('entity_type_fk')
      .notNull()
      .references(() => entityTypes.id), // which entity (Product/Customer/Order…)
    recordId: uuid('record_id'), // parent internal id — no DB FK (polymorphic)
    recordGuuid: uuid('record_guuid').notNull(), // sync-safe parent ref — client tracks by this
    storeFk: uuid('store_fk').references(() => stores.id), // null = user-level
    kind: varchar('kind', { length: 50 }).notNull(), // 'image' | 'document' | 'receipt' | 'logo' …
    storageKey: varchar('storage_key', { length: 1000 }).notNull(),
    storageUrl: text('storage_url'),
    thumbnailUrl: text('thumbnail_url'),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: varchar('sha256', { length: 64 }),
    originalFilename: varchar('original_filename', { length: 255 }),
    isPrivate: boolean('is_private').notNull().default(true),
    description: varchar('description', { length: 255 }),
    ...auditColumns,
  },
  (t) => [
    // No DB FK on recordId/recordGuuid (polymorphic) — enforce in app + orphan-cleanup job.
    index('idx_files_entity_record').on(t.entityTypeFk, t.recordGuuid),
    index('idx_files_store').on(t.storeFk),
  ],
);

export const filesConfig = pgTable(
  'files_config',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityTypeFk: uuid('entity_type_fk')
      .notNull()
      .references(() => entityTypes.id),
    fileKind: varchar('file_kind', { length: 50 }), // scope a rule to one kind
    maxFileSizeBytes: bigint('max_file_size_bytes', {
      mode: 'number',
    }).notNull(), // per-file cap
    maxConsolidatedSizeBytes: bigint('max_consolidated_size_bytes', {
      mode: 'number',
    }).notNull(), // total per (entity, record) cap
    validExtensions: varchar('valid_extensions', { length: 1000 }).notNull(), // comma list ('jpg,png,pdf')
    maxAttachmentsAllowed: integer('max_attachments_allowed').notNull(), // count cap per record
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('uk_files_config_entity_kind').on(t.entityTypeFk, t.fileKind),
  ],
);

// ─── Polymorphic Common — notes / address / communication / contact_person
// (table-architecture.md §34) ───────────────────────────────────────────────
// entityTypeFk + recordGuuid attaches any of these to any entity. recordId has
// no DB FK (polymorphic) — enforce in app.

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guuid: uuid('guuid').notNull().defaultRandom().unique(),
    entityTypeFk: uuid('entity_type_fk')
      .notNull()
      .references(() => entityTypes.id),
    recordId: uuid('record_id'),
    recordGuuid: uuid('record_guuid').notNull(),
    storeFk: uuid('store_fk')
      .notNull()
      .references(() => stores.id),
    body: text('body').notNull(),
    isPinned: boolean('is_pinned').notNull().default(false),
    ...auditColumns,
  },
  (t) => [index('idx_notes_entity_record').on(t.entityTypeFk, t.recordGuuid)],
);

export const address = pgTable(
  'address',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guuid: uuid('guuid').notNull().defaultRandom().unique(),
    entityTypeFk: uuid('entity_type_fk')
      .notNull()
      .references(() => entityTypes.id),
    recordId: uuid('record_id'),
    recordGuuid: uuid('record_guuid').notNull(),
    // lookup type ADDRESS_TYPE — billing/shipping/registered
    addressTypeLookupFk: uuid('address_type_lookup_fk').references(
      () => lookup.id,
    ),
    line1: varchar('line1', { length: 200 }).notNull(),
    line2: varchar('line2', { length: 200 }),
    city: varchar('city', { length: 100 }),
    stateCode: varchar('state_code', { length: 2 }), // GST state code
    pincode: varchar('pincode', { length: 6 }),
    countryFk: uuid('country_fk').references(() => country.id),
    isPrimary: boolean('is_primary').notNull().default(false),
    isBilling: boolean('is_billing').notNull().default(false),
    ...auditColumns,
  },
  (t) => [index('idx_address_entity_record').on(t.entityTypeFk, t.recordGuuid)],
);

export const communication = pgTable(
  'communication',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guuid: uuid('guuid').notNull().defaultRandom().unique(),
    entityTypeFk: uuid('entity_type_fk')
      .notNull()
      .references(() => entityTypes.id),
    recordId: uuid('record_id'),
    recordGuuid: uuid('record_guuid').notNull(),
    // lookup type COMMUNICATION_TYPE
    communicationTypeLookupFk: uuid('communication_type_lookup_fk').references(
      () => lookup.id,
    ),
    email: varchar('email', { length: 255 }),
    phone: varchar('phone', { length: 20 }),
    fax: varchar('fax', { length: 20 }),
    website: varchar('website', { length: 255 }),
    callingCode: varchar('calling_code', { length: 10 }),
    isVerified: boolean('is_verified').notNull().default(false),
    isPrimary: boolean('is_primary').notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    index('idx_communication_entity_record').on(t.entityTypeFk, t.recordGuuid),
  ],
);

// ═══ POS master data (sync-engine.md §3, WS-1) ═══════════════════════════════
// Every table here is store-partitioned (BR-SYNC-001) and carries syncColumns
// (guuid / row_version / modified_at). modified_at + row_version are maintained
// by the sync_touch_row trigger — application code never sets them. The
// (store_fk, modified_at, id) index is the delta-pull keyset (§7).

// ─── Units (order 2) — pull-only for now ─────────────────────────────────────

export const units = pgTable(
  'units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeFk: uuid('store_fk')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // 'Kilogram'
    abbreviation: text('abbreviation').notNull(), // 'kg'
    allowsFractions: boolean('allows_fractions').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...syncColumns(),
    ...auditColumns,
  },
  (t) => [index('idx_units_sync').on(t.storeFk, t.modifiedAt, t.id)],
);

// ─── Tax rates (order 6) — pull-only for now ─────────────────────────────────

export const taxRates = pgTable(
  'taxrates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeFk: uuid('store_fk')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // 'GST 18%'
    ratePercent: numeric('rate_percent', { precision: 6, scale: 3 }).notNull(),
    isInclusive: boolean('is_inclusive').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...syncColumns(),
    ...auditColumns,
  },
  (t) => [index('idx_taxrates_sync').on(t.storeFk, t.modifiedAt, t.id)],
);

// ─── Payment methods (order 5) — pull-only for now ───────────────────────────

export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeFk: uuid('store_fk')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    code: text('code').notNull(), // 'CASH', 'UPI', …
    label: text('label').notNull(),
    kind: text('kind', {
      enum: ['cash', 'card', 'upi', 'bank', 'credit', 'other'],
    })
      .notNull()
      .default('other'),
    sortOrder: integer('sort_order').notNull().default(0),
    isSystem: boolean('is_system').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...syncColumns(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('uk_payment_methods_store_code').on(t.storeFk, t.code),
    index('idx_payment_methods_sync').on(t.storeFk, t.modifiedAt, t.id),
  ],
);

// ─── Payment accounts (order 15) — writable via sync ─────────────────────────

export const paymentAccounts = pgTable(
  'payment_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeFk: uuid('store_fk')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // 'Counter cash', 'HDFC current'
    paymentMethodFk: uuid('payment_method_fk').references(
      () => paymentMethods.id,
    ),
    // Method-specific settlement details (UPI id, account number tail, …).
    details: jsonb('details'),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...syncColumns(),
    ...auditColumns,
  },
  (t) => [index('idx_payment_accounts_sync').on(t.storeFk, t.modifiedAt, t.id)],
);

// ─── Products (order 10) — writable via sync ─────────────────────────────────
// Deliberately NO stock_quantity column: live stock is the stock_event ledger's
// projection (§14, S-32) — the read cache lands in a separate non-synced table
// with the WS-5 stock schema so recomputes never bump this watermark.

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeFk: uuid('store_fk')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sku: text('sku'),
    barcode: text('barcode'),
    categoryLookupFk: uuid('category_lookup_fk').references(() => lookup.id),
    unitFk: uuid('unit_fk').references(() => units.id),
    taxrateFk: uuid('taxrate_fk').references(() => taxRates.id),
    sellingPrice: numeric('selling_price', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    costPrice: numeric('cost_price', { precision: 12, scale: 2 }),
    mrp: numeric('mrp', { precision: 12, scale: 2 }),
    hsnCode: text('hsn_code'),
    trackInventory: boolean('track_inventory').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    ...syncColumns(),
    ...auditColumns,
  },
  (t) => [
    index('idx_products_sync').on(t.storeFk, t.modifiedAt, t.id),
    index('idx_products_barcode').on(t.storeFk, t.barcode),
    // Backstops the app-level PRODUCT_SKU_EXISTS check against offline-sync
    // races — scoped to live rows so a deleted product frees its SKU.
    uniqueIndex('uk_products_store_sku')
      .on(t.storeFk, t.sku)
      .where(sql`${t.sku} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    // Same guarantee for barcode — the product spec promises "this barcode is
    // already used by another product" is checked at sync; previously only
    // SKU actually had the backstop.
    uniqueIndex('uk_products_store_barcode')
      .on(t.storeFk, t.barcode)
      .where(sql`${t.barcode} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

// ─── Product cases (order 10) — pack sizes ('Box of 12') ─────────────────────

export const productCases = pgTable(
  'product_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeFk: uuid('store_fk')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    productFk: uuid('product_fk')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull(), // base units per case
    barcode: text('barcode'),
    sellingPrice: numeric('selling_price', { precision: 12, scale: 2 }),
    isActive: boolean('is_active').notNull().default(true),
    ...syncColumns(),
    ...auditColumns,
  },
  (t) => [
    index('idx_product_cases_sync').on(t.storeFk, t.modifiedAt, t.id),
    index('idx_product_cases_product').on(t.productFk),
    uniqueIndex('uk_product_cases_store_barcode')
      .on(t.storeFk, t.barcode)
      .where(sql`${t.barcode} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

// ─── Customers (order 20) — writable via sync ────────────────────────────────

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeFk: uuid('store_fk')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    gstNumber: text('gst_number'),
    customerTypeLookupFk: uuid('customer_type_lookup_fk').references(
      () => lookup.id,
    ),
    creditLimit: numeric('credit_limit', { precision: 12, scale: 2 }),
    isActive: boolean('is_active').notNull().default(true),
    ...syncColumns(),
    ...auditColumns,
  },
  (t) => [
    index('idx_customers_sync').on(t.storeFk, t.modifiedAt, t.id),
    index('idx_customers_phone').on(t.storeFk, t.phone),
    // BR-CUS-001/BR-CUS-004 (customers spec): name/email unique per store,
    // case-insensitive. Previously stated in the spec as "checked at sync"
    // but never actually backed by anything.
    uniqueIndex('uk_customers_store_name').on(t.storeFk, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('uk_customers_store_email').on(t.storeFk, sql`lower(${t.email})`)
      .where(sql`${t.email} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

// ─── Suppliers (order 21) — writable via sync ────────────────────────────────

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeFk: uuid('store_fk')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    gstNumber: text('gst_number'),
    isActive: boolean('is_active').notNull().default(true),
    ...syncColumns(),
    ...auditColumns,
  },
  (t) => [
    index('idx_suppliers_sync').on(t.storeFk, t.modifiedAt, t.id),
    // BR-SUP-003/BR-SUP-006 (suppliers spec): name/email unique per store,
    // case-insensitive — same backstop gap as customers.
    uniqueIndex('uk_suppliers_store_name').on(t.storeFk, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('uk_suppliers_store_email').on(t.storeFk, sql`lower(${t.email})`)
      .where(sql`${t.email} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

// ═══ Sync engine infrastructure (sync-engine.md §5/§8/§10/§11) ════════════════

// ─── Tombstones (§8) — the shared delete stream ──────────────────────────────
// Written in the SAME tx as the business delete (TombstoneRepository takes a
// mandatory tx). One (deleted_at, id) keyset per store; re-delete updates
// deleted_at so it re-surfaces through the keyset. Retention 195d > the 180d
// cursor horizon (S-22 — retention must EXCEED the horizon).

export const syncTombstones = pgTable(
  'sync_tombstones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeFk: uuid('store_fk')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(), // registry key, e.g. 'product'
    entityGuuid: uuid('entity_guuid').notNull(),
    entityId: uuid('entity_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedByUserFk: uuid('deleted_by_user_fk'),
    hardDelete: boolean('hard_delete').notNull().default(false),
  },
  (t) => [
    // Idempotent — re-delete updates deleted_at on this key instead of duplicating.
    uniqueIndex('uk_tombstone_entity').on(t.entityType, t.entityGuuid),
    index('idx_tombstones_stream').on(t.storeFk, t.deletedAt, t.id),
  ],
);

// ─── Cold-start progress (§5) ────────────────────────────────────────────────
// PK (store, device, entity) — two devices cold-start independently. cursor is
// the last-delivered row id (`${entity_type}:` prefixed on the wire). Each row
// carries ITS OWN session anchor (S-4): a new entity type cold-started on an
// otherwise-complete device anchors its delta cursor at its own session start,
// never at a months-old inherited one.

export const syncInitProgress = pgTable(
  'sync_init_progress',
  {
    storeFk: uuid('store_fk')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    deviceFk: uuid('device_fk')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    phase: text('phase', { enum: ['in_progress', 'completed'] })
      .notNull()
      .default('in_progress'),
    cursor: text('cursor'), // last row id of the previous page
    sessionStartedAt: timestamp('session_started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.storeFk, t.deviceFk, t.entityType] })],
);

// ─── Mutation idempotency (§10) ──────────────────────────────────────────────
// Compound PK (mutation_id, user_fk) — cross-tenant-safe at the DB. The row is
// written in the SAME tx as the business write (the engine's single most
// important correctness property). Only terminal outcomes live here; TTLs are
// enforced at read time (conflict = 5 min, applied/rejected = 45 d ≥ the client
// DLQ max-dwell, S-35) so the cleanup cron is space-only.

export const syncMutationIdempotency = pgTable(
  'sync_mutation_idempotency',
  {
    mutationId: text('mutation_id').notNull(), // client ULID
    userFk: uuid('user_fk')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    storeFk: uuid('store_fk').notNull(),
    entityType: text('entity_type').notNull(),
    action: text('action').notNull(),
    status: text('status', {
      enum: ['applied', 'rejected', 'conflict'],
    }).notNull(),
    result: jsonb('result').notNull(), // cached wire result, replayed on duplicate
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Store-scoped, not just user-scoped — a user with roles at two stores
    // must dedupe independently per store; a mutation_id collision across
    // their stores must never short-circuit a real write as "duplicate".
    primaryKey({ columns: [t.mutationId, t.userFk, t.storeFk] }),
    index('idx_sync_idem_created').on(t.createdAt), // cleanup scan
  ],
);

// ─── Poison-mutation failure tracking (S-7) ──────────────────────────────────
// Upserted OUTSIDE the (rolled-back) business tx when a handler 5xxes. Past
// POISON_MUTATION_MAX_FAILURES the mutation is terminally rejected instead of
// re-running its handler on every sync forever.

export const syncMutationFailures = pgTable(
  'sync_mutation_failures',
  {
    mutationId: text('mutation_id').notNull(),
    userFk: uuid('user_fk')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    storeFk: uuid('store_fk')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    failureCount: integer('failure_count').notNull().default(1),
    lastErrorMessage: text('last_error_message'),
    firstFailedAt: timestamp('first_failed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastFailedAt: timestamp('last_failed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // Store-scoped for the same reason as sync_mutation_idempotency above —
  // a poison count for the same mutation_id at store A must never bleed
  // into the failure budget of the same id submitted at store B.
  (t) => [primaryKey({ columns: [t.mutationId, t.userFk, t.storeFk] })],
);

// ─── Sync conflicts (§11) ────────────────────────────────────────────────────
// Bookkeeping only: the server never merges. conflict_type routes client UX
// (§11.1): MASTER_DATA → rebase, VALIDATION → fix input, BUSINESS_RULE → explain.

export const syncConflicts = pgTable(
  'sync_conflicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mutationId: text('mutation_id').notNull(),
    userFk: uuid('user_fk')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    storeFk: uuid('store_fk')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityGuuid: uuid('entity_guuid'),
    conflictType: text('conflict_type', {
      enum: ['MASTER_DATA', 'VALIDATION', 'BUSINESS_RULE'],
    }).notNull(),
    serverRow: jsonb('server_row'),
    clientPayload: jsonb('client_payload').notNull(),
    message: text('message'),
    status: text('status', { enum: ['open', 'resolved', 'discarded'] })
      .notNull()
      .default('open'),
    note: text('note'),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Store-scoped — see sync_mutation_idempotency above for why (mutation_id,
    // user_fk) alone isn't a safe dedupe key for a multi-store user.
    uniqueIndex('uk_sync_conflicts_mutation').on(t.mutationId, t.userFk, t.storeFk),
    index('idx_sync_conflicts_store_status').on(t.storeFk, t.status),
  ],
);

export const contactPerson = pgTable(
  'contact_person',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guuid: uuid('guuid').notNull().defaultRandom().unique(),
    entityTypeFk: uuid('entity_type_fk')
      .notNull()
      .references(() => entityTypes.id),
    recordId: uuid('record_id'),
    recordGuuid: uuid('record_guuid').notNull(),
    // lookup type CONTACT_PERSON_TYPE
    contactTypeLookupFk: uuid('contact_type_lookup_fk').references(
      () => lookup.id,
    ),
    // lookup type TITLE
    salutationLookupFk: uuid('salutation_lookup_fk').references(
      () => lookup.id,
    ),
    firstName: varchar('first_name', { length: 50 }),
    lastName: varchar('last_name', { length: 50 }),
    designation: varchar('designation', { length: 50 }),
    email: varchar('email', { length: 255 }),
    officeNumber: varchar('office_number', { length: 20 }),
    mobileNumber: varchar('mobile_number', { length: 20 }),
    isPrimary: boolean('is_primary').notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    index('idx_contact_person_entity_record').on(t.entityTypeFk, t.recordGuuid),
  ],
);
