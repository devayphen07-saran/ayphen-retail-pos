import { z } from 'zod';

export const CreateStoreDtoSchema = z.object({
  name:       z.string().min(1).max(120),
  gst_number: z.string().max(20).optional(),
  address:    z.string().max(500).optional(),
  phone:      z.string().max(20).optional(),
  email:      z.string().email().optional(),
});
export type CreateStoreDto = z.infer<typeof CreateStoreDtoSchema>;
