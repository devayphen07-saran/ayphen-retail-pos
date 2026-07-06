/** Wire type for GET /entity-types — mirrors `entity-types.mapper.ts`. */
export interface EntityTypeResponse {
  code:                 string;
  label:                string;
  is_offline_safe:      boolean;
  supports_attachments: boolean;
}
