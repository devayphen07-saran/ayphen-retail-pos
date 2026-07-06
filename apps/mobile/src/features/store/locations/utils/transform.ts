import type { CreateLocationForm, EditLocationForm } from '../types/schema';

export interface CreateLocationPayload {
  name: string;
  is_default: boolean;
}

/** Pure form → CreateLocationDtoSchema payload. */
export function toCreateLocationPayload(
  values: CreateLocationForm,
): CreateLocationPayload {
  return { name: values.name.trim(), is_default: values.isDefault };
}

export interface UpdateLocationPayload {
  name?: string;
  enable?: boolean;
}

/**
 * PATCH payload for an edit — emits ONLY the keys the user actually changed
 * (forms-agent.md §6/§11A), so an untouched field is never clobbered server-side.
 */
export function toUpdateLocationPayload(
  values: EditLocationForm,
  dirty: Partial<Record<keyof EditLocationForm, unknown>>,
): UpdateLocationPayload {
  const payload: UpdateLocationPayload = {};
  if (dirty.name) payload.name = values.name.trim();
  if (dirty.enable) payload.enable = values.enable;
  return payload;
}