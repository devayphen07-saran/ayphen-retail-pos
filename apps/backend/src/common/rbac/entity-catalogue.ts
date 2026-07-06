/**
 * RBAC entity catalogue — the declared set of protectable entities and the
 * lookups over them. Split out of the former `permission-matrix.constants.ts`
 * god-file; re-exported from that barrel for backward compatibility.
 */

export interface EntityDef {
  code: string;
  label: string;
  isOfflineSafe: boolean;
  supportsAttachments: boolean;
}

/**
 * 29 entities.
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
  {
    code: 'Lookup',
    label: 'Lookup Values',
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

export function isEntityCode(value: string): value is EntityCode {
  return (ENTITY_CODES as readonly string[]).includes(value);
}

export function supportsAttachments(entity: EntityCode): boolean {
  return ENTITY_BY_CODE[entity].supportsAttachments;
}

export function isOfflineSafeEntity(entity: EntityCode): boolean {
  return ENTITY_BY_CODE[entity].isOfflineSafe;
}
