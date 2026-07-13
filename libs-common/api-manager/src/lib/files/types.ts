/**
 * Wire types for the files domain. Field names mirror the backend DTOs
 * (snake_case) exactly — see `apps/backend/src/files/dto`.
 */

/** Returned by `POST .../files/temp` — the staging handle held until commit. */
export interface TempUploadResponse {
  guuid: string;
  file_name: string;
  size_bytes: number;
  mime_type: string;
  sha256: string | null;
  /** ISO — staging TTL; commit after this fails with TEMP_FILE_EXPIRED. */
  expires_at: string;
  /** Short-lived presigned GET for immediate client preview. */
  preview_url: string;
}

/** A committed file. `url` is a fresh presigned GET (~35 min) — never cache it. */
export interface FileResponse {
  guuid: string;
  kind: string;
  mime_type: string;
  size_bytes: number;
  original_filename: string | null;
  description: string | null;
  url: string;
  thumbnail_url: string | null;
  created_at: string;
}

/** Body of `POST .../files/commit`. `file_guuids` are staged temps, in order. */
export interface CommitFilesRequest {
  entity_type: string;
  record_guuid: string;
  record_id?: string;
  kind: string;
  file_guuids: string[];
  description?: string;
}

/** Query for `GET .../files`. */
export interface ListFilesQuery {
  entity_type: string;
  record_guuid: string;
}
