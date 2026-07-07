/**
 * Special (beyond-CRUD) action grants and the critical-action set.
 * Split out of the former `permission-matrix.constants.ts` god-file;
 * re-exported from that barrel for backward compatibility.
 */
import type { SpecialActionMap } from './crud-matrices.js';

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
