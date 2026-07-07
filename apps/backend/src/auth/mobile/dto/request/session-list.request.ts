import { z } from 'zod';
import { clampLimit } from '#common/pagination/paginated-response.js';

/** Query params for GET /auth/mobile/sessions — `limit` reuses clampLimit's
 *  lenient def/max policy so this migration doesn't change its behavior. */
export const SessionListQuerySchema = z.object({
  limit:  z.string().optional().transform((raw) => clampLimit(raw)),
  cursor: z.string().max(512).optional(),
});
export type SessionListQuery = z.infer<typeof SessionListQuerySchema>;