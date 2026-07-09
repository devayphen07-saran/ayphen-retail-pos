/**
 * A committed file as seen by clients. The `url` is a freshly-generated,
 * short-lived presigned GET regenerated on every read — never stored, never the
 * raw bucket URL, and the internal `storage_key` is never exposed (Part C
 * §C3 / P1-3).
 */
export interface FileResponse {
  guuid:             string;
  kind:              string;
  mime_type:         string;
  size_bytes:        number;
  original_filename: string | null;
  description:       string | null;
  url:               string;        // presigned GET, ~35 min
  thumbnail_url:     string | null;
  created_at:        string;
}
