import { z } from 'zod';

/** Set the user's chosen workspace mode (mobile-03 §3c/3d). */
export const AccountModeDtoSchema = z.object({
  mode: z.enum(['business', 'personal']),
});
export type AccountModeDto = z.infer<typeof AccountModeDtoSchema>;
