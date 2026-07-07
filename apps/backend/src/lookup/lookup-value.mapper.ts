import type { LookupValueRow } from './lookup.repository.js';

export interface LookupValueResponse {
  guuid:       string;
  code:        string;
  label:       string;
  description: string | null;
  sort_order:  number;
  is_system:   boolean;
  row_version: number;
}

/** Pure domain → snake_case mapper (layered-architecture §3.7). */
export const LookupValueMapper = {
  toResponse(row: LookupValueRow): LookupValueResponse {
    return {
      guuid:       row.guuid,
      code:        row.code,
      label:       row.label,
      description: row.description,
      sort_order:  row.sortOrder,
      is_system:   row.isSystem,
      row_version: row.rowVersion,
    };
  },
  toList(rows: LookupValueRow[]): LookupValueResponse[] {
    return rows.map(LookupValueMapper.toResponse);
  },
};
