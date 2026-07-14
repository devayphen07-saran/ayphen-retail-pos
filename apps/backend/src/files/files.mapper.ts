import type { StagedUpload, FileView } from './types/file-views.js';
import type { FileResponse } from './dto/file.response.js';
import type { TempUploadResponse } from './dto/temp-upload.response.js';

/**
 * Pure domain-view → snake_case response mapping (layered-architecture §3.7).
 * The service already attached the presigned URL and stripped the storage key
 * on its way to the view, so this mapper stays pure — no DI, no async, no
 * storage-provider access — and lists every field explicitly (security by
 * omission).
 */
export const FilesMapper = {
  toTempResponse(view: StagedUpload): TempUploadResponse {
    return {
      guuid:       view.guuid,
      file_name:   view.fileName,
      size_bytes:  view.sizeBytes,
      mime_type:   view.mimeType,
      sha256:      view.sha256,
      expires_at:  view.expiresAt.toISOString(),
      preview_url: view.previewUrl,
    };
  },

  toFileResponse(view: FileView): FileResponse {
    return {
      guuid:             view.guuid,
      kind:              view.kind,
      mime_type:         view.mimeType,
      size_bytes:        view.sizeBytes,
      original_filename: view.originalFilename,
      description:       view.description,
      url:               view.url,
      thumbnail_url:     view.thumbnailUrl,
      created_at:        view.createdAt.toISOString(),
    };
  },

  toFileResponseList(views: FileView[]): FileResponse[] {
    return views.map((v) => FilesMapper.toFileResponse(v));
  },

  toFileResponseByRecordMap(
    grouped: Record<string, FileView[]>,
  ): Record<string, FileResponse[]> {
    return Object.fromEntries(
      Object.entries(grouped).map(([recordGuuid, views]) => [
        recordGuuid,
        FilesMapper.toFileResponseList(views),
      ]),
    );
  },
};