import { APIData, APIMethod } from '../api-handler';

/**
 * Custom roles + permission matrix (rbac.md §21). Every route lives under
 * `stores/:storeId/roles` — mirrors `apps/backend/src/stores/role.controller.ts`.
 */

/** Custom roles in a store (list view — no permission matrix). */
export const GET_ROLES = new APIData('stores/:storeId/roles', APIMethod.GET);

/** A single role's current permission matrix (edit-screen prefill target). */
export const GET_ROLE = new APIData('stores/:storeId/roles/:roleId', APIMethod.GET);

/** Create a custom role. Starts seeded with the DEFAULT_ROLE_CRUD baseline server-side. */
export const CREATE_ROLE = new APIData('stores/:storeId/roles', APIMethod.POST);

/** Full-replace a role's CRUD grants. */
export const UPDATE_ROLE_PERMISSIONS = new APIData(
  'stores/:storeId/roles/:roleId/permissions',
  APIMethod.PATCH,
);

/** Delete a custom role. Blocked server-side if any member is still assigned. */
export const DELETE_ROLE = new APIData('stores/:storeId/roles/:roleId', APIMethod.DELETE);

/** Assign an existing account member to a custom role. */
export const ASSIGN_ROLE = new APIData('stores/:storeId/roles/:roleId/assign', APIMethod.POST);

/** Revoke a user's role assignment. */
export const REVOKE_ROLE = new APIData(
  'stores/:storeId/roles/:roleId/members/:userId',
  APIMethod.DELETE,
);
