import { z } from 'zod';

export const CreateInvitationDtoSchema = z
  .object({
    role_id: z.string().uuid(),
    phone:   z.string().max(20).optional(),
    email:   z.string().email().optional(),
  })
  .refine((d) => d.phone || d.email, {
    message: 'phone or email is required',
  });
export type CreateInvitationDto = z.infer<typeof CreateInvitationDtoSchema>;

export const AcceptInvitationDtoSchema = z.object({
  token: z.string().min(1),
});
export type AcceptInvitationDto = z.infer<typeof AcceptInvitationDtoSchema>;

export const RejectInvitationDtoSchema = z.object({
  token: z.string().min(1),
});
export type RejectInvitationDto = z.infer<typeof RejectInvitationDtoSchema>;
