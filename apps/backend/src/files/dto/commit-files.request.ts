import { z } from 'zod';

/**
 * `POST /files/commit` — promote staged temp files into permanent, record-linked
 * `files` rows (the "link on save" half of the two-phase flow). The parent
 * record is addressed by `record_guuid` (sync-safe), scoped to the caller's
 * store by the guard. Temp files are resolved owner-scoped by their guuids.
 *
 * Wire format is snake_case (client contract); validated through the shared
 * `parse()` helper and reshaped to a camelCase command by the request mapper.
 */
export const CommitFilesDtoSchema = z.object({
  /** entity_types.code — e.g. 'Product', 'Order', 'Customer'. */
  entity_type: z.string().min(1).max(100),
  /** Sync-safe parent reference the client tracks by. */
  record_guuid: z.string().uuid(),
  /** Optional internal parent id (no DB FK — polymorphic). */
  record_id: z.string().uuid().optional(),
  /** 'image' | 'document' | 'receipt' | 'logo' … drives the files_config rule. */
  kind: z.string().min(1).max(50),
  /** Staged temp-file guuids to commit, in order. */
  file_guuids: z.array(z.string().uuid()).nonempty(),
  description: z.string().max(255).optional(),
});

export type CommitFilesDto = z.infer<typeof CommitFilesDtoSchema>;
