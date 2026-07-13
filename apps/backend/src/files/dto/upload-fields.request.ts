import { z } from 'zod';
import { MAX_BATCH_RECORDS } from '../files.repository.js';

/**
 * Multipart text fields accompanying a staged upload (`POST /files/temp`).
 * The binary part is handled by the multer FileInterceptor; these are the
 * snake_case text fields, validated through the shared `parse()` helper.
 */
export const StageUploadFieldsSchema = z.object({
  entity_type: z.string().min(1).max(100),
  kind: z.string().min(1).max(50),
});
export type StageUploadFields = z.infer<typeof StageUploadFieldsSchema>;

/** Query params for listing a record's files (`GET /files`). */
export const ListFilesQuerySchema = z.object({
  entity_type: z.string().min(1).max(100),
  record_guuid: z.string().uuid(),
});
export type ListFilesQuery = z.infer<typeof ListFilesQuerySchema>;

/**
 * Query params for the batched grid read (`GET /files/by-records`, P1-10):
 * `record_guuids` is a comma-separated list, deduped and capped so one grid
 * render is one request. The response is a `{ [record_guuid]: FileResponse[] }`
 * map.
 */
export const ListFilesBatchQuerySchema = z.object({
  entity_type: z.string().min(1).max(100),
  record_guuids: z
    .string()
    .min(1)
    .transform((s) => [...new Set(s.split(',').map((g) => g.trim()).filter(Boolean))])
    .pipe(z.array(z.string().uuid()).min(1).max(MAX_BATCH_RECORDS)),
});
export type ListFilesBatchQuery = z.infer<typeof ListFilesBatchQuerySchema>;
