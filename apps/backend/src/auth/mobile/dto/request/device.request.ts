import { z } from 'zod';

/** Shared device payload sent on login/signup verify. */
export const DeviceDtoSchema = z.object({
  platform:    z.enum(['ios', 'android']),
  app_version: z.string(),
  os_version:  z.string().optional(),
  model:       z.string().optional(),
  public_key:   z.string().min(1),
  push_token:   z.string().optional(),
  attestation:  z.string().optional(),
});
export type DeviceDto = z.infer<typeof DeviceDtoSchema>;

export const PHONE_REGEX = /^\+?[1-9]\d{6,14}$/;
