import { z } from 'zod';

export const CreateLookupValueDtoSchema = z.object({
  code:        z.string().min(1).max(40),
  label:       z.string().min(1).max(80),
  description: z.string().max(200).optional(),
  sort_order:  z.number().int().optional(),
});
export type CreateLookupValueDto = z.infer<typeof CreateLookupValueDtoSchema>;

export const UpdateLookupValueDtoSchema = z.object({
  label:       z.string().min(1).max(80).optional(),
  description: z.string().max(200).optional(),
  sort_order:  z.number().int().optional(),
  is_hidden:   z.boolean().optional(),
  // Optimistic lock — the row_version the client last read. Same gate the
  // sync-push mutation handler already enforces for this table; the REST
  // endpoint previously didn't, so a concurrent admin edit could silently
  // last-write-win with no conflict signal.
  expected_row_version: z.number().int().positive(),
});
export type UpdateLookupValueDto = z.infer<typeof UpdateLookupValueDtoSchema>;

export const CreateLookupTypeDtoSchema = z.object({
  code:        z.string().min(1).max(40),
  title:       z.string().min(1).max(80),
  description: z.string().max(200).optional(),
});
export type CreateLookupTypeDto = z.infer<typeof CreateLookupTypeDtoSchema>;
