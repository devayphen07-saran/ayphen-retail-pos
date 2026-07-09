import { z } from 'zod';

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
