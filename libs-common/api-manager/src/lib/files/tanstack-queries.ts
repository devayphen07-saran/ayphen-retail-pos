import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  STAGE_FILE,
  CANCEL_STAGED,
  COMMIT_FILES,
  LIST_FILES,
  LIST_FILES_BATCH,
  DELETE_FILE,
  RESTORE_FILE,
} from './api-data';
import type { TempUploadResponse, FileResponse, CommitFilesRequest } from './types';

/** Query-key factory — record-scoped so a parent form's file list invalidates cleanly. */
export const fileKeys = {
  all: ['files'] as const,
  record: (storeId: string, entityType: string, recordGuuid: string) =>
    [...fileKeys.all, storeId, entityType, recordGuuid] as const,
  batch: (storeId: string, entityType: string, recordGuuids: string[]) =>
    [...fileKeys.all, 'batch', storeId, entityType, [...recordGuuids].sort().join(',')] as const,
};

/**
 * Phase 1 — stage one file (multipart). The caller assembles the `FormData`
 * (the `file` binary plus `entity_type` + `kind` text fields) and passes it as
 * `{ pathParam: { storeId }, formData }`. Returns a `guuid` to commit later.
 */
export const useStageFileMutation = () =>
  useMutation(STAGE_FILE.uploadMutationOptions<TempUploadResponse>());

/** Cancel a still-staged upload (user removed it before saving the parent). */
export const useCancelStagedMutation = () =>
  useMutation(CANCEL_STAGED.mutationOptions<void, void>());

/**
 * Phase 2 — commit staged temps for a saved parent record. On success the
 * record's file list is invalidated so the freshly-committed files render.
 */
export const useCommitFilesMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    COMMIT_FILES.mutationOptions<FileResponse[], CommitFilesRequest>({
      onSuccess: (_data, vars) => {
        const storeId = vars.pathParam?.storeId;
        const body = vars.bodyParam;
        if (storeId && body) {
          queryClient.invalidateQueries({
            queryKey: fileKeys.record(String(storeId), body.entity_type, body.record_guuid),
          });
        }
      },
    }),
  );
};

/** Active files attached to a record — the edit-screen list. */
export const useRecordFilesQuery = (
  storeId: string,
  entityType: string,
  recordGuuid: string,
  options?: { enabled?: boolean },
) =>
  useQuery({
    ...LIST_FILES.queryOptions<FileResponse[]>({
      pathParam: { storeId },
      queryParam: { entity_type: entityType, record_guuid: recordGuuid },
    }),
    queryKey: fileKeys.record(storeId, entityType, recordGuuid),
    enabled: options?.enabled ?? (!!storeId && !!recordGuuid),
  });

/**
 * Batched grid read (P1-10): files for many records in one request, keyed by
 * `record_guuid`. Used by the product grid on a non-capturing device. Disabled
 * when the id list is empty so an empty grid fires no request.
 */
export const useRecordFilesBatchQuery = (
  storeId: string,
  entityType: string,
  recordGuuids: string[],
  options?: { enabled?: boolean },
) =>
  useQuery({
    ...LIST_FILES_BATCH.queryOptions<Record<string, FileResponse[]>>({
      pathParam: { storeId },
      queryParam: { entity_type: entityType, record_guuids: recordGuuids.join(',') },
    }),
    queryKey: fileKeys.batch(storeId, entityType, recordGuuids),
    enabled: options?.enabled ?? (!!storeId && recordGuuids.length > 0),
  });

/** Soft-delete a committed file (→ trash). Invalidates every record list. */
export const useDeleteFileMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    DELETE_FILE.mutationOptions<void, void>({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: fileKeys.all }),
    }),
  );
};

/** Restore a soft-deleted file. Invalidates every record list. */
export const useRestoreFileMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    RESTORE_FILE.mutationOptions<FileResponse, void>({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: fileKeys.all }),
    }),
  );
};
