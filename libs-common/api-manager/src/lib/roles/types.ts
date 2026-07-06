/**
 * Wire types for the roles domain. Field names mirror the backend DTOs
 * (snake_case) exactly — see `apps/backend/src/stores/dto/role.response.ts`.
 */

export type CrudAction = 'view' | 'create' | 'edit' | 'delete';

export interface RoleResponse {
  id:          string;
  code:        string;
  name:        string;
  description: string | null;
  is_editable: boolean;
}

export interface RoleEntityPermissions {
  view:   boolean;
  create: boolean;
  edit:   boolean;
  delete: boolean;
}

export interface RoleDetailResponse extends RoleResponse {
  permissions: Record<string, RoleEntityPermissions>;
}

export interface CreatedRoleResponse {
  id:   string;
  name: string;
}

export interface CreateRoleRequest {
  name:        string;
  description?: string;
}

export interface PermissionGrant {
  entity: string;
  action: CrudAction;
}

export interface UpdateRolePermissionsRequest {
  permissions: PermissionGrant[];
}
