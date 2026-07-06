import { z } from 'zod';

/**
 * Invite a person to a custom role scoped to one+ locations. Role and locations
 * are FIRST-CLASS schema fields (not separate useState), so the schema is the
 * single source of truth for validity (§1) — the submit handler no longer
 * re-validates them by hand.
 */
export const inviteStaffSchema = z
  .object({
    method: z.enum(['phone', 'email']),
    contact: z.string().trim().min(1, 'Required'),
    roleId: z.string().min(1, 'Select a role'),
    locationIds: z.array(z.string()).min(1, 'Select at least one location'),
  })
  .superRefine((v, ctx) => {
    if (v.method === 'email' && !z.email().safeParse(v.contact).success) {
      ctx.addIssue({ path: ['contact'], code: 'custom', message: 'Enter a valid email' });
    }
    if (v.method === 'phone' && v.contact.replace(/\D/g, '').length < 8) {
      ctx.addIssue({ path: ['contact'], code: 'custom', message: 'Enter a valid phone number' });
    }
  });
export type InviteStaffForm = z.infer<typeof inviteStaffSchema>;
export const DEFAULT_INVITE_STAFF_VALUES: InviteStaffForm = {
  method: 'phone',
  contact: '',
  roleId: '',
  locationIds: [],
};