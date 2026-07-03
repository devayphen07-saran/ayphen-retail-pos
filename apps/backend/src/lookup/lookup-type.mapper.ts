import type { LookupTypeRow } from './lookup-type.repository.js';

export interface LookupTypeResponse {
  code:        string;
  title:       string;
  description: string | null;
}

/** Pure domain → snake_case mapper (layered-architecture §3.7). */
export const LookupTypeMapper = {
  toResponse(row: LookupTypeRow): LookupTypeResponse {
    return { code: row.code, title: row.title, description: row.description };
  },
  toList(rows: LookupTypeRow[]): LookupTypeResponse[] {
    return rows.map(LookupTypeMapper.toResponse);
  },
};
