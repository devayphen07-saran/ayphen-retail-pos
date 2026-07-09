/**
 * sync entity_type → RBAC entity code, mirroring the backend's
 * `handler.permissionEntity` (apps/backend/src/sync/push/handlers/*.ts).
 * Used by permission-rebase.ts to detect a REVOKED `${entity}:view` grant and
 * purge the matching local table — entities not listed here have no
 * view-gating today (reference data everyone in the store can see).
 */
export const SYNC_ENTITY_PERMISSION: Readonly<Record<string, string>> = {
  product: 'Product',
  product_case: 'Product',
  customer: 'Customer',
  payment_method: 'Payment',
};
