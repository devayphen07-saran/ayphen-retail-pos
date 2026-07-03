import type { EntityTypeRow } from './entity-types.repository.js';

export interface EntityTypeResponse {
  code:                 string;
  label:                string;
  is_offline_safe:      boolean;
  supports_attachments: boolean;
}

/** Pure domain → snake_case mapper (layered-architecture §3.7). */
export const EntityTypeMapper = {
  toResponse(row: EntityTypeRow): EntityTypeResponse {
    return {
      code:                 row.code,
      label:                row.label,
      is_offline_safe:      row.isOfflineSafe,
      supports_attachments: row.supportsAttachments,
    };
  },
  toList(rows: EntityTypeRow[]): EntityTypeResponse[] {
    return rows.map(EntityTypeMapper.toResponse);
  },
};
