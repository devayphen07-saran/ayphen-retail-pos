import { z } from 'zod';

/** PATCH /me/profile — both fields optional, only supplied keys are written.
 *  No `phone` here: it's the login credential and changing it needs its own
 *  OTP-reverification flow, not a plain PATCH. */
export const UpdateProfileDtoSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().toLowerCase().email().max(255).optional(),
});
export type UpdateProfileDto = z.infer<typeof UpdateProfileDtoSchema>;
