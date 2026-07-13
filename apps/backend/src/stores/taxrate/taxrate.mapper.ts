import type { TaxRateRow } from './taxrate.repository.js';
import type { TaxRateResponse } from './dto/taxrate.response.js';

/** Maps the DB row shape to the snake_case wire contract. */
export const TaxRateResponseMapper = {
  toResponse(row: TaxRateRow): TaxRateResponse {
    return {
      id:           row.id,
      name:         row.name,
      rate_percent: row.ratePercent,
      is_inclusive: row.isInclusive,
      is_active:    row.isActive,
      guuid:        row.guuid,
      row_version:  row.rowVersion,
    };
  },

  toListResponse(rows: TaxRateRow[]): TaxRateResponse[] {
    return rows.map((r) => TaxRateResponseMapper.toResponse(r));
  },
};