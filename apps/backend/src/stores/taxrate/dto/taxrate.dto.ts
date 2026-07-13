import { z } from 'zod';

/** Rate is a percentage 0–100 with ≤3 decimals, matching the DB
 *  `numeric(6,3)` column. The service rounds to 3 dp before persisting so a
 *  client sending more precision is normalized rather than rejected. */
export const CreateTaxRateDtoSchema = z.object({
  name:         z.string().trim().min(1).max(100),
  rate_percent: z.number().min(0).max(100),
  is_inclusive: z.boolean().optional().default(false),
});
export type CreateTaxRateDto = z.infer<typeof CreateTaxRateDtoSchema>;

/** Same shape plus the optimistic-lock token the client last saw
 *  (TaxRateResponse.row_version). A stale value means someone else edited this
 *  rate since the edit screen loaded — the update is rejected, not clobbered. */
export const UpdateTaxRateDtoSchema = CreateTaxRateDtoSchema.extend({
  expected_row_version: z.number().int().positive(),
});
export type UpdateTaxRateDto = z.infer<typeof UpdateTaxRateDtoSchema>;