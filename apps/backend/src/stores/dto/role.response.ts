/** GET /stores/:storeId/roles list item (layered-architecture §3.8). snake_case wire contract. */
export interface RoleResponse {
  id:           string;
  code:         string;
  name:         string;
  is_editable:  boolean;
}

/** POST /stores/:storeId/roles response. */
export interface CreatedRoleResponse {
  id:   string;
  name: string;
}
