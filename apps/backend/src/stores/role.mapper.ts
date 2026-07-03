import type { RoleRow } from './role.repository.js';
import type { RoleResponse, CreatedRoleResponse } from './dto/role.response.js';

/** Pure domain → snake_case contract mapper (layered-architecture §3.7). */
export const RoleResponseMapper = {
  toResponse(r: RoleRow): RoleResponse {
    return {
      id:          r.id,
      code:        r.code,
      name:        r.name,
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
};
