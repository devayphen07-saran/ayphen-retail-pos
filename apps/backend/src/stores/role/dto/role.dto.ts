import { z } from 'zod';

export const CreateRoleDtoSchema = z.object({
  name:        z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});
export type CreateRoleDto = z.infer<typeof CreateRoleDtoSchema>;

export const UpdatePermissionsDtoSchema = z.object({
  permissions: z
    .array(
      z.object({
        entity: z.string().min(1),
        action: z.enum(['view', 'create', 'edit', 'delete']),
      }),
    )
    .max(200),
  // Optimistic-lock guard — the version the client last saw (from
  // RoleDetailResponse.row_version). A stale value means someone else edited
  // this role's permissions since the client loaded the edit screen.
  expected_row_version: z.number().int().positive(),
});
export type UpdatePermissionsDto = z.infer<typeof UpdatePermissionsDtoSchema>;

export const AssignRoleDtoSchema = z.object({
  user_id: z.string().uuid(),
});
export type AssignRoleDto = z.infer<typeof AssignRoleDtoSchema>;
