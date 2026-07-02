import type { EffectivePermissions } from './effective-permissions.js';

/**
 * Written by TenantGuard to request.context after resolving + authorizing the
 * store (rbac.md §12). PermissionsGuard reads storeId; downstream handlers read
 * the resolved permissions.
 */
export interface ResolvedStoreContext {
  storeId:      string;  // the store's uuid (also its public identifier — no separate guuid)
  accountId:    string;
  isLocked:     boolean;
  locationId?:  string;  // written by LocationGuard when @LocationContext is present (§8.1)
  permissions?: EffectivePermissions; // written by PermissionsGuard
}

declare global {
  namespace Express {
    interface Request {
      context?: ResolvedStoreContext;
    }
  }
}
