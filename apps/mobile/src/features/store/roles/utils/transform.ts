import type { CreateRoleForm } from '../types/schema';

export interface CreateRolePayload {
  name: string;
  description?: string;
}

/** Pure form → CreateRoleDtoSchema payload (empty description → omitted). */
export function toCreateRolePayload(values: CreateRoleForm): CreateRolePayload {
  return {
    name: values.name.trim(),
    description: values.description?.trim() || undefined,
  };
}
