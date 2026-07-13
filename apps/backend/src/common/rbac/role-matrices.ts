/**
 * Per-role CRUD matrices — STORE_OWNER, SUPER_ADMIN, and the default
 * custom-role seed. Split out of the former `permission-matrix.constants.ts`
 * god-file; re-exported from that barrel for backward compatibility.
 */
import { ENTITY_CODES, type EntityCode } from './entity-catalogue.js';
import {
  freezeCrud,
  FULL,
  NO_DELETE,
  VIEW_EDIT,
  VIEW_CREATE,
  VIEW_ONLY,
  type CrudMatrix,
  type CrudMatrixMap,
  type PartialCrudMatrixMap,
} from './crud-matrices.js';

// ── STORE_OWNER CRUD matrix ──────────────────────────────────────────────────

/**
 * Owner rules:
 * - destructive deletion is blocked on audit-sensitive financial/history entities
 * - settings/subscription remain limited to view/edit rather than broad create/delete
 * - user removal is modelled through UserRoleMapping / invitation lifecycle
 */
export const STORE_OWNER_CRUD: CrudMatrixMap = Object.freeze({
  Product: FULL,
  Order: FULL,
  // Sales/refunds are financial audit history — no delete, matches CashMovement
  // (docs/prd/accounts-and-ledger.md: a sale is voided/refunded via a new
  // event, never deleted).
  Sale: NO_DELETE,
  Refund: NO_DELETE,
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
  Lookup: FULL,
});

// ── SUPER_ADMIN CRUD matrix ──────────────────────────────────────────────────

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

// ── Default custom-role seed ─────────────────────────────────────────────────

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
  // A cashier rings up sales by default; refunds are absent (explicit grant
  // only) — same "financial/destructive actions come through explicit grants"
  // policy as this file's own comment above already states.
  Sale: VIEW_CREATE,
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
  // Staff can read dropdowns (payment terms, reasons, …) but adding/editing/
  // removing store-custom values is owner-only — not part of the default
  // custom-role seed (lookup-entity-prd.md §9 BR-2).
  Lookup: VIEW_ONLY,
});

/**
 * Entities intentionally absent from the default custom-role seed.
 * These require explicit grant by an owner/admin.
 */
export const DEFAULT_ROLE_ABSENT = ENTITY_CODES.filter(
  (code) => !(code in DEFAULT_ROLE_CRUD),
) as readonly EntityCode[];

/**
 * Role codes that are system-managed, not custom roles a store owner creates.
 * Reserved (can't be used as a custom role name), non-assignable/-revocable
 * through the normal role-management endpoints, and excluded from the
 * store's editable role list.
 */
export const SYSTEM_ROLE_CODES: ReadonlySet<string> = new Set([
  'USER',
  'STORE_OWNER',
  'SUPER_ADMIN',
]);
