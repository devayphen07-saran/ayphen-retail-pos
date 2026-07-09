import type { FileRow, TempFileRow } from './files.repository.js';
import type { FileResponse } from './dto/file.response.js';
import type { TempUploadResponse } from './dto/temp-upload.response.js';

/**
 * Pure row → snake_case response mapping (layered-architecture §3.7). Presigned
 * URLs are computed by the service (they're async + per-read) and injected here,
 * so the mapper stays pure and never touches the storage provider — and never
 * emits the raw `storageKey`/`storageUrl`.
 */
export const FilesMapper = {
  toTempResponse(row: TempFileRow, previewUrl: string): TempUploadResponse {
    return {
      guuid:       row.guuid,
      file_name:   row.fileName,
      size_bytes:  row.sizeBytes,
      mime_type:   row.mimeType,
      sha256:      row.sha256,
      expires_at:  row.expiresAt.toISOString(),
      preview_url: previewUrl,
    };
  },

  toFileResponse(row: FileRow, signedUrl: string): FileResponse {
    return {
      guuid:             row.guuid,
      kind:              row.kind,
      mime_type:         row.mimeType,
      size_bytes:        row.sizeBytes,
      original_filename: row.originalFilename,
      description:       row.description,
      url:               signedUrl,
      thumbnail_url:     row.thumbnailUrl,
      created_at:        row.createdAt.toISOString(),
    };
  },
};
