import { z } from 'zod';

/**
 * Create a location — mirrors the backend CreateLocationDtoSchema
 * (name + is_default only). Kept separate from the edit schema because the two
 * backend contracts genuinely differ (create's `is_default` vs edit's `enable`,
 * see EditLocationScreen) — a documented §11A structural split, not value drift.
 */
export const createLocationSchema = z.object({
  name: z.string().trim().min(1, 'Location name is required').max(100, 'Too long'),
  isDefault: z.boolean(),
});
export type CreateLocationForm = z.infer<typeof createLocationSchema>;
export const DEFAULT_CREATE_LOCATION_VALUES: CreateLocationForm = {
  name: '',
  isDefault: false,
};

/** Rename / enable-disable an existing location (UpdateLocationDtoSchema: name + enable). */
export const editLocationSchema = z.object({
  name: z.string().trim().min(1, 'Location name is required').max(100, 'Too long'),
  enable: z.boolean(),
});
export type EditLocationForm = z.infer<typeof editLocationSchema>;