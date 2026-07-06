import type { InviteStaffForm } from '../types/schema';

export interface CreateInvitationPayload {
  role_id:       string;
  phone?:        string;
  email?:        string;
  location_ids:  string[];
}

/** Pure form → CreateInvitationDtoSchema payload (phone XOR email by method). */
export function toCreateInvitationPayload(
  values: InviteStaffForm,
): CreateInvitationPayload {
  return {
    role_id: values.roleId,
    ...(values.method === 'phone'
      ? { phone: values.contact.trim() }
      : { email: values.contact.trim().toLowerCase() }),
    location_ids: values.locationIds,
  };
}
