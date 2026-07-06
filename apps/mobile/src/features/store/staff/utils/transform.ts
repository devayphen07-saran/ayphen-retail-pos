import type { InviteStaffForm } from '../types/schema';

export interface CreateInvitationPayload {
  role_id:       string;
  phone:         string;
  location_ids:  string[];
}

/** Pure form → CreateInvitationDtoSchema payload (phone-only invites). */
export function toCreateInvitationPayload(
  values: InviteStaffForm,
): CreateInvitationPayload {
  return {
    role_id: values.roleId,
    phone: values.contact.trim(),
    location_ids: values.locationIds,
  };
}
