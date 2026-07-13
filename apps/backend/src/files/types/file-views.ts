/**
 * Domain result shapes for the files service (camelCase, internal). The service
 * builds these — pairing a persisted row with the freshly-signed URL — and
 * returns them to the controller, which maps them to the snake_case wire DTOs
 * via `FilesMapper`. Keeping the service on these views (not the raw repo rows)
 * means the secret `storageKey`/`storageUrl` columns never escape the service,
 * and the service never imports a response DTO (§3.5/§3.7).
 */

/** A freshly-staged temp upload (phase 1). */
export interface StagedUpload {
  guuid: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  sha256: string | null;
  expiresAt: Date;
  /** Short-lived presigned GET for immediate client preview. */
  previewUrl: string;
}

/** A committed file as the client should see it, with a signed URL attached. */
export interface FileView {
  guuid: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  originalFilename: string | null;
  description: string | null;
  /** Presigned GET, regenerated on every read (~35 min). */
  url: string;
  thumbnailUrl: string | null;
  createdAt: Date;
}