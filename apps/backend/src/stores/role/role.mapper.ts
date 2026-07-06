import type { RoleRow, RoleGrant } from './role.repository.js';
import { CRUD_ACTIONS, ENTITY_CODES } from '#common/rbac/permission-matrix.constants.js';
import type {
  RoleResponse,
  RoleDetailResponse,
  RoleEntityPermissions,
  CreatedRoleResponse,
} from './dto/role.response.js';

/** Pure domain → snake_case contract mapper (layered-architecture §3.7). */
export const RoleResponseMapper = {
  toResponse(r: RoleRow): RoleResponse {
    return {
      id:          r.id,
      code:        r.code,
      name:        r.name,
      description: r.description,
      is_editable: r.isEditable,
    };
  },

  toListResponse(rows: RoleRow[]): RoleResponse[] {
    return rows.map(RoleResponseMapper.toResponse);
  },

  toCreatedResponse(r: { id: string; name: string }): CreatedRoleResponse {
    return {
      id:   r.id,
      name: r.name,
    };
  },

  /** Every known entity, defaulted to all-false, so the client always gets a
   *  complete matrix to render regardless of how few grants are active. */
  toDetailResponse(role: RoleRow, grants: RoleGrant[]): RoleDetailResponse {
    const permissions: Record<string, RoleEntityPermissions> = {};
    for (const code of ENTITY_CODES) {
      permissions[code] = { view: false, create: false, edit: false, delete: false };
    }
    for (const grant of grants) {
      const entry = permissions[grant.entityCode];
      if (entry && CRUD_ACTIONS.includes(grant.action)) entry[grant.action] = true;
    }
    return { ...RoleResponseMapper.toResponse(role), permissions };
  },
};
