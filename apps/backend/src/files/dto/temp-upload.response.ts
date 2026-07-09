/**
 * Returned by `POST /files/temp` — the staging handle the client holds until it
 * saves the parent record and commits. `guuid` is the only identifier the
 * client ever sees; the internal storage key is never exposed.
 */
export interface TempUploadResponse {
  guuid:        string;
  file_name:    string;
  size_bytes:   number;
  mime_type:    string;
  sha256:       string | null;
  expires_at:   string; // ISO — staging TTL
  preview_url:  string; // short-lived presigned GET for immediate client preview
}
