import { z } from 'zod';

export const CreateInvitationDtoSchema = z
  .object({
    role_id:      z.string().uuid(),
    phone:        z.string().max(20).optional(),
    email:        z.string().email().optional(),
    // Which locations the invited role is scoped to (the "WHERE" gate the
    // invitee gets on accept). At least one — an invite must grant access
    // somewhere, and location scoping is not optional in this flow.
    location_ids: z.array(z.string().uuid()).min(1).max(50),
  })
  .refine((d) => d.phone || d.email, {
    message: 'phone or email is required',
  });
export type CreateInvitationDto = z.infer<typeof CreateInvitationDtoSchema>;

// Tokens are randomBytes(24).toString('base64url') — 32 chars, no padding.
// 64 gives headroom without leaving the field unbounded.
export const AcceptInvitationDtoSchema = z.object({
  token: z.string().min(1).max(64),
});
export type AcceptInvitationDto = z.infer<typeof AcceptInvitationDtoSchema>;

export const RejectInvitationDtoSchema = z.object({
  token: z.string().min(1).max(64),
});
export type RejectInvitationDto = z.infer<typeof RejectInvitationDtoSchema>;
