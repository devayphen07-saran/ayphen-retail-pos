import { z } from 'zod';

/** Token rotation request. */
export const RefreshDtoSchema = z.object({
  refresh_token:    z.string().min(1),
  challenge_id:     z.string().uuid().optional(),
  device_signature: z.string().optional(),
  snapshot_version: z.number().int().optional(),
});
export type RefreshDto = z.infer<typeof RefreshDtoSchema>;
