import { z } from 'zod';

/** Token rotation request. */
export const RefreshDtoSchema = z.object({
  refresh_token:    z.string().min(1),
  challenge_id:     z.string().uuid().optional(),
  device_signature: z.string().optional(),
  snapshot_version: z.number().int().optional(),
});
export type RefreshDto = z.infer<typeof RefreshDtoSchema>;

/**
 * Request for a device-binding challenge used by refresh. Public (no access
 * token): the refresh token itself identifies the device to challenge.
 */
export const RefreshChallengeDtoSchema = z.object({
  refresh_token: z.string().min(1),
});
export type RefreshChallengeDto = z.infer<typeof RefreshChallengeDtoSchema>;
