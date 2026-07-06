import { z } from 'zod';

// 2-digit state code + 10-char PAN + 1 entity-code digit + 'Z' + 1 checksum char.
const GSTIN_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z]Z[0-9A-Z]$/;

export const CreateStoreDtoSchema = z.object({
  name:       z.string().min(1).max(120),
  gst_number: z.string().regex(GSTIN_REGEX, 'Invalid GSTIN').optional(),
  address:    z.string().max(500).optional(),
  phone:      z.string().max(20).optional(),
  email:      z.string().email().optional(),
});
export type CreateStoreDto = z.infer<typeof CreateStoreDtoSchema>;
