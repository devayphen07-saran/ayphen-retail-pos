/** GET /stores/:storeId/roles list item (layered-architecture §3.8). snake_case wire contract. */
export interface RoleResponse {
  id:           string;
  code:         string;
  name:         string;
  description:  string | null;
  is_editable:  boolean;
}

/** One entity's CRUD grant state — the permission-matrix's per-row shape. */
export interface RoleEntityPermissions {
  view:   boolean;
  create: boolean;
  edit:   boolean;
  delete: boolean;
}

/** GET /stores/:storeId/roles/:roleId — role + its current permission matrix. */
export interface RoleDetailResponse extends RoleResponse {
  permissions: Record<string, RoleEntityPermissions>;
  // Optimistic-lock token — round-trip this as `expected_row_version` on
  // PATCH .../permissions so a stale edit is rejected instead of silently
  // clobbering someone else's concurrent change.
  row_version: number;
}

/** POST /stores/:storeId/roles response. */
export interface CreatedRoleResponse {
  id:   string;
  name: string;
}
