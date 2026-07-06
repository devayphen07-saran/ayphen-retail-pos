import { z } from 'zod';

/** Create a custom role — mirrors CreateRoleDtoSchema (name + optional description). */
export const createRoleSchema = z.object({
  name: z.string().trim().min(1, 'Role name is required').max(100, 'Too long'),
  description: z.string().trim().max(500, 'Too long').optional().or(z.literal('')),
});
export type CreateRoleForm = z.infer<typeof createRoleSchema>;
export const DEFAULT_CREATE_ROLE_VALUES: CreateRoleForm = {
  name: '',
  description: '',
};