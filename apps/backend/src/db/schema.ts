import {
  pgTable,
  text,
  uuid,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns } from './audit';

// ─── Accounts ─────────────────────────────────────────────────────────────────
// Top-level billing/tenant entity. Each account owns one or more stores.

export const accounts = pgTable('accounts', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  accountNumber:      text('account_number').notNull().unique(),
  name:               text('name').notNull(),
  // The user who owns this account. Account-wide authority (manage subscription,
  // create stores, transfer/delete account) is a direct ownership check against
  // this column — NOT an RBAC role. Store authority lives in userRoleMappings.
  ownerUserFk:        uuid('owner_user_fk').references(() => users.id),
  gstNumber:          text('gst_number'),                       // §26.4
  billingAddress:     jsonb('billing_address'),                 // §26.4
  razorpayCustomerId: text('razorpay_customer_id'),
  createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:          timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Plans ────────────────────────────────────────────────────────────────────

export const plans = pgTable('plans', {
  id:          uuid('id').primaryKey().defaultRandom(),
  name:        text('name').notNull().unique(),   // 'starter' | 'growth' | 'enterprise'
  displayName: text('display_name').notNull(),
  isActive:    boolean('is_active').notNull().default(true),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Plan Entitlements (numeric limits) ───────────────────────────────────────
// value = null means unlimited

export const planEntitlements = pgTable(
  'plan_entitlements',
  {
    id:     uuid('id').primaryKey().defaultRandom(),
    planFk: uuid('plan_fk').notNull().references(() => plans.id, { onDelete: 'cascade' }),
    key:    text('key').notNull(),   // 'max_stores' | 'max_devices_per_store' | 'max_products' …
    value:  integer('value'),        // null = unlimited
  },
  (t) => [uniqueIndex('plan_entitlements_plan_key_uq').on(t.planFk, t.key)],
);

// ─── Plan Features (boolean capabilities) ────────────────────────────────────

export const planFeatures = pgTable(
  'plan_features',
  {
    id:      uuid('id').primaryKey().defaultRandom(),
    planFk:  uuid('plan_fk').notNull().references(() => plans.id, { onDelete: 'cascade' }),
    key:     text('key').notNull(),   // 'barcode_scanning' | 'multi_store' | 'api_access' …
    enabled: boolean('enabled').notNull().default(false),
  },
  (t) => [uniqueIndex('plan_features_plan_key_uq').on(t.planFk, t.key)],
);

// ─── Stores ──────────────────────────────────────────────────────────────────

export const stores = pgTable('stores', {
  id:             uuid('id').primaryKey().defaultRandom(),
  accountFk:      uuid('account_fk').notNull().references(() => accounts.id),
  name:           text('name').notNull(),
  gstNumber:      text('gst_number'),
  address:        text('address'),
  phone:          text('phone'),
  email:          text('email'),
  invoicePrefix:  text('invoice_prefix').notNull().default('INV'),
  invoiceCounter: integer('invoice_counter').notNull().default(0),
  isActive:       boolean('is_active').notNull().default(true),
  locked:         boolean('locked').notNull().default(false),
  ...auditColumns,
});

// ─── Locations (rbac.md §26.1) ────────────────────────────────────────────────
// A physical place where POS runs, under a store. Head Office (is_primary=true)
// is auto-provisioned at store creation and counts as slot 1 of
// max_locations_per_store; it is immune to downgrade-locking. Never hard-deleted
// — archive via isActive=false. One primary per store (partial unique index).

export const locations = pgTable(
  'locations',
  {
    id:           uuid('id').primaryKey().defaultRandom(),
    storeFk:      uuid('store_fk').notNull().references(() => stores.id, { onDelete: 'cascade' }),
    name:         text('name').notNull(),
    isPrimary:    boolean('is_primary').notNull().default(false),  // true = Head Office
    isDefault:    boolean('is_default').notNull().default(false),  // device opens into this one
    enable:       boolean('enable').notNull().default(true),       // operational on/off (guarded)
    isActive:     boolean('is_active').notNull().default(true),    // soft-delete
    displayOrder: integer('display_order').notNull().default(0),
    locked:       boolean('locked').notNull().default(false),      // downgrade-locked
    archivedAt:   timestamp('archived_at', { withTimezone: true }),
    createdAt:    timestamp('created_at',  { withTimezone: true }).notNull().defaultNow(),
    updatedAt:    timestamp('updated_at',  { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Exactly one Head Office per store, and exactly one default per store
    // (device-management §5B / adoption §8.2). Both enforced at the DB level.
    uniqueIndex('uk_location_primary').on(t.storeFk).where(sql`${t.isPrimary} = true`),
    uniqueIndex('uk_location_default').on(t.storeFk).where(sql`${t.isDefault} = true`),
    index('idx_location_store_active').on(t.storeFk).where(sql`${t.isActive} = true`),
  ],
);

// ─── User ↔ Location assignment (adoption §8.1, rbac.md §26.3) ─────────────────
// Which locations within a store a user may work at. Store-scoped roles say WHAT
// a user can do; this says WHERE. STORE_OWNER bypasses (implicitly all locations),
// so owners need no rows here. No store_fk column — store derives via
// location.store_fk (avoids denormalization drift).

export const userLocationMappings = pgTable(
  'user_location_mappings',
  {
    id:         uuid('id').primaryKey().defaultRandom(),
    userFk:     uuid('user_fk').notNull().references(() => users.id,       { onDelete: 'cascade' }),
    locationFk: uuid('location_fk').notNull().references(() => locations.id, { onDelete: 'cascade' }),
    assignedBy: uuid('assigned_by').references(() => users.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt:  timestamp('revoked_at',  { withTimezone: true }),  // null = active
  },
  (t) => [
    uniqueIndex('uk_ulm_user_location').on(t.userFk, t.locationFk),
    index('idx_ulm_user_active').on(t.userFk, t.revokedAt),
    index('idx_ulm_location').on(t.locationFk),
  ],
);

// ─── Users ───────────────────────────────────────────────────────────────────
// CHECK (email IS NOT NULL OR phone IS NOT NULL) enforced at DB level via migration

export const users = pgTable('users', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  guuid:               uuid('guuid').notNull().defaultRandom(),
  email:               text('email').unique(),
  phone:               text('phone').unique(),
  name:                text('name').notNull(),
  emailVerified:       boolean('email_verified').notNull().default(false),
  phoneVerified:       boolean('phone_verified').notNull().default(false),
  primaryLoginMethod:  text('primary_login_method', {
    enum: ['otp', 'password', 'google'],
  }).notNull().default('otp'),
  permissionsVersion:  integer('permissions_version').notNull().default(1),
  status:              text('status', {
    enum: ['active', 'suspended', 'locked'],
  }).notNull().default('active'),
  isBlocked:           boolean('is_blocked').notNull().default(false),
  blockedReason:       text('blocked_reason'),
  failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
  accountLockedUntil:  timestamp('account_locked_until', { withTimezone: true }),
  mfaEnabled:          boolean('mfa_enabled').notNull().default(false),
  passwordChangedAt:   timestamp('password_changed_at', { withTimezone: true }),
  lastLoginAt:         timestamp('last_login_at', { withTimezone: true }),
  imageAttachmentFk:   uuid('image_attachment_fk'),
  deletedAt:           timestamp('deleted_at', { withTimezone: true }),
  createdAt:           timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:           timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Account ↔ Users (many-to-many, role scoped) ──────────────────────────────

// Pure account membership (which users belong to which account). Authority —
// including account ownership — is a role in userRoleMappings, never a flag here.
// ACCOUNT_OWNER (system role, store_fk NULL) = owns the account/billing;
// STORE_OWNER (system role, store_fk set) = owns a specific store (§4, §26.4).
export const accountUsers = pgTable(
  'account_users',
  {
    id:        uuid('id').primaryKey().defaultRandom(),
    accountFk: uuid('account_fk').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    userFk:    uuid('user_fk').notNull().references(() => users.id,    { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('account_users_account_user_uq').on(t.accountFk, t.userFk),
    index('idx_account_users_user').on(t.userFk),               // §26.15
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
    id:          uuid('id').primaryKey().defaultRandom(),
    guuid:       uuid('guuid').notNull().defaultRandom().unique(),
    storeFk:     uuid('store_fk').references(() => stores.id),  // NULL for system roles
    code:        text('code').notNull(),                        // 'STORE_OWNER', 'CASHIER', …
    name:        text('name').notNull(),                        // human label ("Head Cashier")
    description: text('description'),
    isEditable:  boolean('is_editable').notNull().default(true), // false for system roles
    ...auditColumns,
  },
  (t) => [
    // System-wide roles (USER, SUPER_ADMIN) must have store_fk NULL.
    // STORE_OWNER is exempt: it is a system role but store-scoped (one per store).
    check(
      'system_role_no_store',
      sql`${t.storeFk} IS NULL OR ${t.code} NOT IN ('SUPER_ADMIN', 'USER')`,
    ),
    // System-wide roles (storeFk NULL) are unique by code; custom roles may reuse
    // codes across stores. Also gives seed onConflictDoNothing a stable target.
    uniqueIndex('roles_system_code_uq').on(t.code).where(sql`${t.storeFk} IS NULL`),
    // One role name per store (custom roles); scoped so different stores may reuse names.
    uniqueIndex('roles_store_name_uq').on(t.storeFk, t.name),
    index('idx_roles_store').on(t.storeFk),
  ],
);

// CRUD grants — one row per (role, entity, action). Soft-deleted via revokedAt
// so point-in-time authorization (§17) can ask "was this granted at time T?".
export const rolePermissions = pgTable(
  'role_permissions',
  {
    id:         uuid('id').primaryKey().defaultRandom(),
    roleFk:     uuid('role_fk').notNull().references(() => roles.id),
    entityCode: text('entity_code').notNull(),                  // PascalCase, e.g. 'Order'
    action:     text('action', { enum: ['view', 'create', 'edit', 'delete'] }).notNull(),
    grantedBy:  uuid('granted_by').references(() => users.id),
    grantedAt:  timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt:  timestamp('revoked_at', { withTimezone: true }), // NULL = active grant
  },
  (t) => [
    uniqueIndex('role_permissions_role_entity_action_uq').on(t.roleFk, t.entityCode, t.action),
    index('idx_role_permissions_role').on(t.roleFk),
  ],
);

// Special (beyond-CRUD) action grants — REFUND, VOID, EXPORT, … (§7)
export const roleSpecialPermissions = pgTable(
  'role_special_permissions',
  {
    id:         uuid('id').primaryKey().defaultRandom(),
    roleFk:     uuid('role_fk').notNull().references(() => roles.id),
    entityCode: text('entity_code').notNull(),                  // e.g. 'Order'
    actionCode: text('action_code').notNull(),                 // SCREAMING_SNAKE_CASE, e.g. 'REFUND'
    grantedBy:  uuid('granted_by').references(() => users.id),
    grantedAt:  timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt:  timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('role_special_permissions_uq').on(t.roleFk, t.entityCode, t.actionCode),
    index('idx_role_special_permissions_role').on(t.roleFk),
  ],
);

// User ↔ Role assignment (store-scoped). storeFk NULL = system-wide (e.g. SUPER_ADMIN).
export const userRoleMappings = pgTable(
  'user_role_mappings',
  {
    id:         uuid('id').primaryKey().defaultRandom(),
    userFk:     uuid('user_fk').notNull().references(() => users.id),
    roleFk:     uuid('role_fk').notNull().references(() => roles.id),
    storeFk:    uuid('store_fk').references(() => stores.id),   // NULL for system-wide roles
    assignedBy: uuid('assigned_by').references(() => users.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt:  timestamp('revoked_at',  { withTimezone: true }), // soft-delete
    expiresAt:  timestamp('expires_at',  { withTimezone: true }), // optional temporary assignment
  },
  (t) => [
    uniqueIndex('user_role_mappings_uq').on(t.userFk, t.roleFk, t.storeFk),
    index('idx_user_role_mappings_user_store').on(t.userFk, t.storeFk),
    index('idx_user_role_mappings_role').on(t.roleFk),
  ],
);

// Staff invitations — invite a phone/email to a store with a custom role.
// Only custom roles are assignable via invitation (rbac.md §4, BR-RBAC-006).
export const invitations = pgTable(
  'invitations',
  {
    id:         uuid('id').primaryKey().defaultRandom(),
    storeFk:    uuid('store_fk').notNull().references(() => stores.id),
    roleFk:     uuid('role_fk').notNull().references(() => roles.id),
    phone:      text('phone'),
    email:      text('email'),
    token:      text('token').notNull().unique(),  // opaque accept token
    status:     text('status', {
                  enum: ['pending', 'accepted', 'revoked', 'expired'],
                }).notNull().default('pending'),
    invitedBy:  uuid('invited_by').notNull().references(() => users.id),
    acceptedBy: uuid('accepted_by').references(() => users.id),
    expiresAt:  timestamp('expires_at',  { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt:  timestamp('created_at',  { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_invitations_store').on(t.storeFk),
    index('idx_invitations_phone').on(t.phone),
    index('idx_invitations_status').on(t.status),
  ],
);

// Entity registry — drives the offline snapshot allow-list and attachment support (§5).
export const entityTypes = pgTable('entity_types', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  code:                text('code').notNull().unique(),        // 'Product', 'Order', …
  label:               text('label').notNull(),                // 'Products', 'Orders', …
  isOfflineSafe:       boolean('is_offline_safe').notNull().default(false),
  supportsAttachments: boolean('supports_attachments').notNull().default(false),
});

// ─── Account Subscriptions ────────────────────────────────────────────────────
// One subscription per account (UNIQUE on account_fk).

export const accountSubscriptions = pgTable(
  'account_subscriptions',
  {
    id:                  uuid('id').primaryKey().defaultRandom(),
    accountFk:           uuid('account_fk').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    planFk:              uuid('plan_fk').notNull().references(() => plans.id),
    status:              text('status', {
                           enum: ['trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired'],
                         }).notNull().default('trialing'),
    trialEndsAt:         timestamp('trial_ends_at',        { withTimezone: true }),
    currentPeriodStart:  timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd:    timestamp('current_period_end',   { withTimezone: true }),
    pastDueGraceUntil:   timestamp('past_due_grace_until', { withTimezone: true }),
    // Computed and stored: max(currentPeriodEnd, pastDueGraceUntil, trialEndsAt).
    // SubscriptionStatusGuard reads this column — never derive at query time.
    accessValidUntil:    timestamp('access_valid_until',   { withTimezone: true }),
    cancelAtPeriodEnd:   boolean('cancel_at_period_end').notNull().default(false),
    subscriptionVersion: integer('subscription_version').notNull().default(1),
    hasUsedTrial:        boolean('has_used_trial').notNull().default(false),
    razorpaySubId:       text('razorpay_sub_id'),
    createdAt:           timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:           timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('account_subscriptions_account_uq').on(t.accountFk),
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
    id:          uuid('id').primaryKey().defaultRandom(),
    accountFk:   uuid('account_fk').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    eventType:   text('event_type').notNull(),   // 'SUBSCRIPTION_ACTIVATED' | 'SUBSCRIPTION_PAST_DUE' | …
    payload:     jsonb('payload').notNull(),
    createdAt:   timestamp('created_at',   { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),  // null = pending
  },
  (t) => [
    // Drainer scans pending rows oldest-first; partial index keeps it cheap.
    index('idx_sub_outbox_pending').on(t.createdAt).where(sql`${t.processedAt} IS NULL`),
  ],
);

// ─── Devices ─────────────────────────────────────────────────────────────────

export const devices = pgTable(
  'devices',
  {
    id:                  uuid('id').primaryKey().defaultRandom(),
    userFk:              uuid('user_fk').notNull().references(() => users.id, { onDelete: 'cascade' }),
    publicKey:           text('public_key').notNull(),
    publicKeyHash:       text('public_key_hash').notNull(),
    platform:            text('platform', { enum: ['ios', 'android', 'web'] }).notNull(),
    model:               text('model'),
    osVersion:           text('os_version'),
    appVersion:          text('app_version'),
    attestationVerified: boolean('attestation_verified').notNull().default(false),
    isTrusted:           boolean('is_trusted').notNull().default(false),
    isBlocked:           boolean('is_blocked').notNull().default(false),
    label:               text('label'),
    firstSeenAt:         timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt:          timestamp('last_seen_at',  { withTimezone: true }).notNull().defaultNow(),
    lastIp:              text('last_ip'),
    pushToken:           text('push_token'),
    lastSyncAt:          timestamp('last_sync_at',  { withTimezone: true }),
    blockedAt:           timestamp('blocked_at',    { withTimezone: true }),
  },
  (t) => [uniqueIndex('devices_user_key_hash_uq').on(t.userFk, t.publicKeyHash)],
);

// ─── Device Sessions ──────────────────────────────────────────────────────────

export const deviceSessions = pgTable('device_sessions', {
  id:               uuid('id').primaryKey().defaultRandom(),
  userFk:           uuid('user_fk').notNull().references(() => users.id),
  deviceFk:         uuid('device_fk').notNull().references(() => devices.id),
  expiresAt:        timestamp('expires_at',         { withTimezone: true }).notNull(),
  lastUsedAt:       timestamp('last_used_at',       { withTimezone: true }).notNull().defaultNow(),
  lastStepUpAt:     timestamp('last_step_up_at',    { withTimezone: true }),
  lastStepUpMethod: text('last_step_up_method', { enum: ['otp', 'password', 'biometric'] }),
  stepUpLockedUntil: timestamp('step_up_locked_until', { withTimezone: true }),
  revokedAt:        timestamp('revoked_at',         { withTimezone: true }),
  revokedReason:    text('revoked_reason'),
  currentJti:       text('current_jti'),
  currentJtiExp:    timestamp('current_jti_exp',    { withTimezone: true }),
  ipAtCreation:     text('ip_at_creation'),
  geoAtCreation:    text('geo_at_creation'),
  deviceName:       text('device_name'),
  os:               text('os'),
  appVersion:       text('app_version'),
  platform:         text('platform'),
  lastAppVersion:   text('last_app_version'),
  pushToken:        text('push_token'),
  createdAt:        timestamp('created_at',         { withTimezone: true }).notNull().defaultNow(),
});

// ─── Store Device Access (device-management §3.3) ─────────────────────────────
// The device↔store link that enforces max_devices_per_store. A "slot" is claimed
// when a device first accesses a store (F2). Registration (login) does NOT create
// a row. Exactly one active row per (store, device) — partial unique index. Slots
// free on owner-remove / block / 30-day expiry (status → revoked|expired).

export const storeDeviceAccess = pgTable(
  'store_device_access',
  {
    id:              uuid('id').primaryKey().defaultRandom(),
    storeFk:         uuid('store_fk').notNull().references(() => stores.id, { onDelete: 'cascade' }),
    deviceFk:        uuid('device_fk').notNull().references(() => devices.id, { onDelete: 'cascade' }),
    userFk:          uuid('user_fk').notNull().references(() => users.id,   { onDelete: 'cascade' }),
    // Location the slot is bound to (nullable until the location layer is fully
    // wired; device-mgmt §26.7 makes this the active-location link).
    locationFk:      uuid('location_fk').references(() => locations.id),
    status:          text('status', { enum: ['active', 'revoked', 'expired'] }).notNull().default('active'),
    deviceLabel:     text('device_label'),                          // per-store label (F4)
    firstAccessedAt: timestamp('first_accessed_at', { withTimezone: true }).notNull().defaultNow(),
    lastAccessedAt:  timestamp('last_accessed_at',  { withTimezone: true }).notNull().defaultNow(),
    revokedAt:       timestamp('revoked_at',        { withTimezone: true }),
    revokedBy:       uuid('revoked_by').references(() => users.id),
    revokedReason:   text('revoked_reason', {
                       enum: ['owner_removed', 'stolen', 'auto_expired', 'plan_downgrade', 'released'],
                     }),
    createdAt:       timestamp('created_at',  { withTimezone: true }).notNull().defaultNow(),
    modifiedAt:      timestamp('modified_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One active slot per (store, device) — the concurrency guard for slot claims.
    uniqueIndex('uk_sda_active').on(t.storeFk, t.deviceFk).where(sql`${t.status} = 'active'`),
    index('idx_sda_store').on(t.storeFk),
    index('idx_sda_device').on(t.deviceFk),
  ],
);

// ─── Refresh Tokens ───────────────────────────────────────────────────────────

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id:              uuid('id').primaryKey().defaultRandom(),
    deviceSessionFk: uuid('device_session_fk').notNull().references(() => deviceSessions.id),
    tokenHash:       text('token_hash').notNull().unique(), // SHA-256 of raw token
    parentId:        uuid('parent_id'),                    // self-ref — forms rotation chain
    familyId:        uuid('family_id').notNull(),          // groups all tokens in one rotation chain
    issuedAt:        timestamp('issued_at',  { withTimezone: true }).notNull().defaultNow(),
    expiresAt:       timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt:          timestamp('used_at',    { withTimezone: true }), // non-null = rotated; second use = reuse attack
    revokedAt:       timestamp('revoked_at', { withTimezone: true }),
    revokedReason:   text('revoked_reason'),
  },
  (t) => [uniqueIndex('refresh_tokens_token_hash_uq').on(t.tokenHash)],
);

// ─── OTP Requests ─────────────────────────────────────────────────────────────

export const otpRequests = pgTable('otp_requests', {
  id:          uuid('id').primaryKey().defaultRandom(),
  phone:       text('phone').notNull(),
  purpose:     text('purpose', { enum: ['login', 'signup', 'step_up'] }).notNull(),
  attempts:    integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  consumedAt:  timestamp('consumed_at', { withTimezone: true }),
  expiresAt:   timestamp('expires_at',  { withTimezone: true }).notNull(),
  createdAt:   timestamp('created_at',  { withTimezone: true }).notNull().defaultNow(),
});

// ─── Revoked Tokens (JWT blacklist — persistent fallback behind Redis) ─────────

export const revokedTokens = pgTable('revoked_tokens', {
  jti:       text('jti').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Sequences ────────────────────────────────────────────────────────────────
// One row per document type. Counter incremented inside a SELECT FOR UPDATE transaction.

export const sequences = pgTable('sequences', {
  type:    text('type').primaryKey(),       // 'order' | 'refund' | 'adjustment'
  prefix:  text('prefix').notNull(),        // 'ORD' | 'REF' | 'ADJ'
  counter: integer('counter').notNull().default(0),
  year:    integer('year').notNull(),       // resets to 0 on new calendar year
});

// ─── Login Attempts (rate limiting — IP / account / email / phone) ────────────

export const loginAttempts = pgTable('login_attempts', {
  id:        uuid('id').primaryKey().defaultRandom(),
  ip:        text('ip').notNull(),
  userId:    uuid('user_id'),
  email:     text('email'),
  phone:     text('phone'),
  purpose:   text('purpose').notNull(),   // 'login' | 'otp' | 'signup'
  success:   boolean('success').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Auth Audit Logs (append-only — INSERT only, no UPDATE/DELETE) ───────────
// prefix + suffix + activityType allow UI to render human-readable sentences
// without knowing the event schema

export const auditLogs = pgTable('audit_logs', {
  id:           uuid('id').primaryKey().defaultRandom(),
  event:        text('event').notNull(),
  activityType: text('activity_type').notNull(),
  prefix:       text('prefix').notNull(),
  suffix:       text('suffix').notNull(),
  userId:       uuid('user_id').notNull(),
  actorId:      uuid('actor_id'),
  storeFk:      uuid('store_fk'),                 // §20 — store scope for RBAC denials
  isSuccess:    boolean('is_success').notNull().default(true), // false = denial (SOC2 CC6.3)
  entityType:   text('entity_type'),
  entityId:     text('entity_id'),
  metadata:     jsonb('metadata'),
  ipAddress:    text('ip_address'),
  userAgent:    text('user_agent'),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

