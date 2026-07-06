import { z } from 'zod';
import { phone } from '../../../../schemas/primitives';

/**
 * Invite a person by phone to a custom role scoped to one+ locations. Role and
 * locations are FIRST-CLASS schema fields (not separate useState), so the
 * schema is the single source of truth for validity (§1) — the submit handler
 * no longer re-validates them by hand. `contact` reuses the shared `phone`
 * primitive (schemas/primitives.ts) rather than a second, divergent
 * phone-validity rule — same pattern auth/types/schema.ts already follows.
 */
export const inviteStaffSchema = z.object({
  contact: phone,
  roleId: z.string().min(1, 'Select a role'),
  locationIds: z.array(z.string()).min(1, 'Select at least one location'),
});
export type InviteStaffForm = z.infer<typeof inviteStaffSchema>;
export const DEFAULT_INVITE_STAFF_VALUES: InviteStaffForm = {
  contact: '',
  roleId: '',
  locationIds: [],
};