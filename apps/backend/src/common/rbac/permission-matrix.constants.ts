/**
 * RBAC permission matrix — single source of truth.
 *
 * Design goals:
 * - Strong compile-time typing: entity keys must be valid EntityCode
 * - Conservative defaults: no accidental broad grants
 * - Explicit special-action grants for owner/super-admin
 * - Immutable/shared presets are frozen to prevent accidental mutation
 *
 * Pair this file with a startup validator (e.g. validateMatrixIntegrity()) that checks:
 * - every entity is declared exactly once
 * - every special action is UPPER_SNAKE_CASE
 * - every special action reference points to a declared entity
 * - no system role codes are assignable as custom roles
 */

// ─────────────────────────────────────────────────────────────────────────────
// Action types
// ─────────────────────────────────────────────────────────────────────────────

export const CRUD_ACTIONS = ['view', 'create', 'edit', 'delete'] as const;
export type CrudAction = (typeof CRUD_ACTIONS)[number];

export interface CrudMatrix {
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
}

function freezeCrud(matrix: CrudMatrix): Readonly<CrudMatrix> {
  return Object.freeze({ ...matrix });
}

// CRUD presets
export const FULL = freezeCrud({
  view: true,
  create: true,
  edit: true,
  delete: true,
});

export const NO_DELETE = freezeCrud({
  view: true,
  create: true,
  edit: true,
  delete: false,
});

export const VIEW_EDIT = freezeCrud({
  view: true,
  create: false,
  edit: true,
  delete: false,
});

export const VIEW_CREATE = freezeCrud({
  view: true,
  create: true,
  edit: false,
  delete: false,
});

export const VIEW_ONLY = freezeCrud({
  view: true,
  create: false,
  edit: false,
  delete: false,
});

export const NONE = freezeCrud({
  view: false,
  create: false,
  edit: false,
  delete: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// Entity catalogue
// ─────────────────────────────────────────────────────────────────────────────

export interface EntityDef {
  code: string;
  label: string;
  isOfflineSafe: boolean;
  supportsAttachments: boolean;
}

/**
 * 28 entities.
 *
 * Note:
 * - PersonalExpense / PersonalBudget are kept in the catalogue because they exist
 *   in the wider permission system, but in many apps they are enforced through a
 *   personal-scope permission path instead of store-role assignment alone.
 */
export const ENTITIES = [
  {
    code: 'Product',
    label: 'Products',
    isOfflineSafe: true,
    supportsAttachments: true,
  },
  {
    code: 'Order',
    label: 'Orders',
    isOfflineSafe: true,
    supportsAttachments: true,
  },
  {
    code: 'Customer',
    label: 'Customers',
    isOfflineSafe: true,
    supportsAttachments: true,
  },
  {
    code: 'Supplier',
    label: 'Suppliers',
    isOfflineSafe: true,
    supportsAttachments: true,
  },
  {
    code: 'Inventory',
    label: 'Inventory',
    isOfflineSafe: true,
    supportsAttachments: false,
  },
  {
    code: 'Payment',
    label: 'Payments',
    isOfflineSafe: false,
    supportsAttachments: false,
  },
  {
    code: 'Shift',
    label: 'Shifts',
    isOfflineSafe: true,
    supportsAttachments: true,
  },
  {
    code: 'CashMovement',
    label: 'Cash Movements',
    isOfflineSafe: true,
    supportsAttachments: true,
  },
  {
    code: 'Promotion',
    label: 'Promotions',
    isOfflineSafe: true,
    supportsAttachments: false,
  },
  {
    code: 'StoreCredit',
    label: 'Store Credit',
    isOfflineSafe: true,
    supportsAttachments: false,
  },
  {
    code: 'OverrideToken',
    label: 'Override Tokens',
    isOfflineSafe: true,
    supportsAttachments: false,
  },
  {
    code: 'Report',
    label: 'Reports',
    isOfflineSafe: false,
    supportsAttachments: false,
  },
  {
    code: 'Settings',
    label: 'Settings',
    isOfflineSafe: false,
    supportsAttachments: false,
  },
  {
    code: 'User',
    label: 'Users',
    isOfflineSafe: false,
    supportsAttachments: true,
  },
  {
    code: 'Role',
    label: 'Roles',
    isOfflineSafe: false,
    supportsAttachments: false,
  },
  {
    code: 'Subscription',
    label: 'Subscription',
    isOfflineSafe: false,
    supportsAttachments: false,
  },
  {
    code: 'Device',
    label: 'Devices',
    isOfflineSafe: false,
    supportsAttachments: false,
  },
  {
    code: 'Store',
    label: 'Stores',
    isOfflineSafe: true,
    supportsAttachments: true,
  },
  {
    code: 'Location',
    label: 'Locations',
    isOfflineSafe: true,
    supportsAttachments: false,
  },
  {
    code: 'Invitation',
    label: 'Invitations',
    isOfflineSafe: false,
    supportsAttachments: false,
  },
  {
    code: 'OwnershipTransfer',
    label: 'Ownership Transfers',
    isOfflineSafe: false,
    supportsAttachments: false,
  },
  {
    code: 'UserRoleMapping',
    label: 'Role Assignments',
    isOfflineSafe: false,
    supportsAttachments: false,
  },
  {
    code: 'ShiftAssignment',
    label: 'Shift Assignments',
    isOfflineSafe: true,
    supportsAttachments: false,
  },
  {
    code: 'PersonalExpense',
    label: 'Personal Expenses',
    isOfflineSafe: true,
    supportsAttachments: true,
  },
  {
    code: 'PersonalBudget',
    label: 'Personal Budgets',
    isOfflineSafe: true,
    supportsAttachments: false,
  },
  {
    code: 'Attachment',
    label: 'Attachments',
    isOfflineSafe: false,
    supportsAttachments: false,
  },
  {
    code: 'Note',
    label: 'Notes',
    isOfflineSafe: false,
    supportsAttachments: false,
  },
  {
    code: 'Address',
    label: 'Addresses',
    isOfflineSafe: false,
    supportsAttachments: false,
  },
  {
    code: 'TaxRate',
    label: 'Tax Rates',
    isOfflineSafe: true,
    supportsAttachments: false,
  },
] as const satisfies readonly EntityDef[];

export type EntityCode = (typeof ENTITIES)[number]['code'];

export const ENTITY_CODES = ENTITIES.map(
  (e) => e.code,
) as readonly EntityCode[];

export const ENTITY_BY_CODE: Readonly<
  Record<EntityCode, (typeof ENTITIES)[number]>
> = Object.freeze(
  Object.fromEntries(ENTITIES.map((e) => [e.code, e])) as Record<
    EntityCode,
    (typeof ENTITIES)[number]
  >,
);

export const OFFLINE_SAFE_ENTITY_CODES = ENTITIES.filter(
  (e) => e.isOfflineSafe,
).map((e) => e.code) as readonly EntityCode[];

// ─────────────────────────────────────────────────────────────────────────────
// Role / matrix typing
// ─────────────────────────────────────────────────────────────────────────────

export type CrudMatrixMap = Record<EntityCode, Readonly<CrudMatrix>>;
export type PartialCrudMatrixMap = Partial<
  Record<EntityCode, Readonly<CrudMatrix>>
>;
export type SpecialActionMap = Partial<Record<EntityCode, readonly string[]>>;

// ─────────────────────────────────────────────────────────────────────────────
// STORE_OWNER CRUD matrix
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Owner rules:
 * - destructive deletion is blocked on audit-sensitive financial/history entities
 * - settings/subscription remain limited to view/edit rather than broad create/delete
 * - user removal is modelled through UserRoleMapping / invitation lifecycle
 */
export const STORE_OWNER_CRUD: CrudMatrixMap = Object.freeze({
  Product: FULL,
  Order: FULL,
  Customer: FULL,
  Supplier: FULL,
  Inventory: FULL,
  Payment: FULL,
  Shift: FULL,
  CashMovement: NO_DELETE,
  Promotion: FULL,
  StoreCredit: NO_DELETE,
  OverrideToken: FULL,
  Report: VIEW_ONLY,
  Settings: VIEW_EDIT,
  User: VIEW_CREATE,
  Role: FULL,
  Subscription: VIEW_EDIT,
  Device: freezeCrud({ view: true, create: false, edit: true, delete: true }),
  Store: freezeCrud({ view: true, create: false, edit: true, delete: true }),
  Location: FULL,
  Invitation: FULL,
  OwnershipTransfer: NO_DELETE,
  UserRoleMapping: FULL,
  ShiftAssignment: FULL,
  PersonalExpense: FULL,
  PersonalBudget: FULL,
  Attachment: FULL,
  Note: FULL,
  Address: FULL,
  TaxRate: FULL,
});

// ─────────────────────────────────────────────────────────────────────────────
// Special actions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Only entities listed here support special actions.
 * Keep codes UPPER_SNAKE_CASE.
 */
export const SPECIAL_ACTIONS: SpecialActionMap = Object.freeze({
  Order: [
    'REFUND',
    'VOID',
    'DISCOUNT_APPLY',
    'REFUND_HIGH_VALUE',
    'VIEW_HISTORY',
    'PRICE_OVERRIDE',
  ],
  Inventory: ['TRANSFER', 'AUDIT', 'RESERVE'],
  Report: ['EXPORT', 'TAX_REPORT'],
  Customer: ['EXPORT', 'VIEW_ALL'],
  Shift: ['REOPEN', 'CLOSE_OTHER'],
  CashMovement: ['LARGE_AMOUNT'],
  Subscription: ['PAY', 'UPGRADE', 'DOWNGRADE', 'CANCEL', 'ADD_DEVICE_SLOT'],
  Device: ['REMOTE_WIPE'],
  StoreCredit: ['ISSUE'],
  Store: ['TRANSFER_OWNERSHIP'],
});

/**
 * Owner special grants are explicit on purpose.
 * Do not auto-spread future special actions into owner access silently.
 */
export const STORE_OWNER_SPECIAL: SpecialActionMap = Object.freeze({
  Order: [
    'REFUND',
    'VOID',
    'DISCOUNT_APPLY',
    'REFUND_HIGH_VALUE',
    'VIEW_HISTORY',
    'PRICE_OVERRIDE',
  ],
  Inventory: ['TRANSFER', 'AUDIT', 'RESERVE'],
  Report: ['EXPORT', 'TAX_REPORT'],
  Customer: ['EXPORT', 'VIEW_ALL'],
  Shift: ['REOPEN', 'CLOSE_OTHER'],
  CashMovement: ['LARGE_AMOUNT'],
  Subscription: ['PAY', 'UPGRADE', 'DOWNGRADE', 'CANCEL', 'ADD_DEVICE_SLOT'],
  Device: ['REMOTE_WIPE'],
  StoreCredit: ['ISSUE'],
  Store: ['TRANSFER_OWNERSHIP'],
});

/**
 * Critical operations should use shorter permission-cache TTLs.
 * CRUD delete is inherently critical and is handled separately by the caller.
 */
export const CRITICAL_SPECIAL_ACTIONS: ReadonlySet<string> = new Set([
  'REFUND',
  'VOID',
  'REFUND_HIGH_VALUE',
  'TRANSFER_OWNERSHIP',
  'LARGE_AMOUNT',
  'PAY',
  'REMOTE_WIPE',
  'ISSUE',
]);

// ─────────────────────────────────────────────────────────────────────────────
// SUPER_ADMIN matrix
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Super-admin is broad but still conservative on immutable/audit-heavy entities.
 * Adjust these overrides only with explicit product/compliance review.
 */
export const SUPER_ADMIN_NO_DELETE: ReadonlySet<EntityCode> =
  new Set<EntityCode>([
    'CashMovement',
    'StoreCredit',
    'OwnershipTransfer',
    'Subscription',
  ]);

function buildSuperAdminCrud(): CrudMatrixMap {
  const map = {} as Record<EntityCode, Readonly<CrudMatrix>>;

  for (const entity of ENTITY_CODES) {
    map[entity] = SUPER_ADMIN_NO_DELETE.has(entity) ? NO_DELETE : FULL;
  }

  return Object.freeze(map);
}

export const SUPER_ADMIN_CRUD: CrudMatrixMap = buildSuperAdminCrud();

/**
 * Super-admin special grants are explicit.
 * Keep this reviewed, not implicit.
 */
export const SUPER_ADMIN_SPECIAL: SpecialActionMap = Object.freeze({
  Order: [
    'REFUND',
    'VOID',
    'DISCOUNT_APPLY',
    'REFUND_HIGH_VALUE',
    'VIEW_HISTORY',
    'PRICE_OVERRIDE',
  ],
  Inventory: ['TRANSFER', 'AUDIT', 'RESERVE'],
  Report: ['EXPORT', 'TAX_REPORT'],
  Customer: ['EXPORT', 'VIEW_ALL'],
  Shift: ['REOPEN', 'CLOSE_OTHER'],
  CashMovement: ['LARGE_AMOUNT'],
  Subscription: ['PAY', 'UPGRADE', 'DOWNGRADE', 'CANCEL', 'ADD_DEVICE_SLOT'],
  Device: ['REMOTE_WIPE'],
  StoreCredit: ['ISSUE'],
  Store: ['TRANSFER_OWNERSHIP'],
});

// ─────────────────────────────────────────────────────────────────────────────
// Default custom-role seed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default grants for a newly created custom role.
 *
 * Intentionally conservative:
 * - Order defaults to VIEW_CREATE, not edit, to avoid broad post-sale mutation.
 * - High-risk admin entities are absent by default.
 * - Financial/destructive actions come through explicit grants or specials.
 */
export const DEFAULT_ROLE_CRUD: PartialCrudMatrixMap = Object.freeze({
  Product: VIEW_ONLY,
  Order: VIEW_CREATE,
  Customer: VIEW_ONLY,
  Supplier: VIEW_ONLY,
  Inventory: VIEW_ONLY,
  Payment: VIEW_ONLY,
  Shift: VIEW_CREATE,
  CashMovement: VIEW_ONLY,
  Promotion: VIEW_ONLY,
  StoreCredit: VIEW_ONLY,
  TaxRate: VIEW_ONLY,
  PersonalExpense: NO_DELETE,
  PersonalBudget: NO_DELETE,
  Attachment: VIEW_CREATE,
  Note: NO_DELETE,
  Address: NO_DELETE,
});

/**
 * Entities intentionally absent from the default custom-role seed.
 * These require explicit grant by an owner/admin.
 */
export const DEFAULT_ROLE_ABSENT = ENTITY_CODES.filter(
  (code) => !(code in DEFAULT_ROLE_CRUD),
) as readonly EntityCode[];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function isEntityCode(value: string): value is EntityCode {
  return (ENTITY_CODES as readonly string[]).includes(value);
}

export function supportsAttachments(entity: EntityCode): boolean {
  return ENTITY_BY_CODE[entity].supportsAttachments;
}

export function isOfflineSafeEntity(entity: EntityCode): boolean {
  return ENTITY_BY_CODE[entity].isOfflineSafe;
}

export function getSpecialActions(entity: EntityCode): readonly string[] {
  return SPECIAL_ACTIONS[entity] ?? [];
}

export function isCriticalSpecialAction(actionCode: string): boolean {
  return CRITICAL_SPECIAL_ACTIONS.has(actionCode);
}

export function getDefaultCrudForEntity(
  entity: EntityCode,
): Readonly<CrudMatrix> {
  return DEFAULT_ROLE_CRUD[entity] ?? NONE;
}
