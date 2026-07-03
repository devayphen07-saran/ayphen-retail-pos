import type { CountryRow } from './country.repository.js';
import type { CurrencyRow } from './currency.repository.js';

export interface CountryResponse {
  code:         string;
  name:         string;
  calling_code: string | null;
}

export interface CurrencyResponse {
  code:   string;
  name:   string;
  symbol: string;
}

/** Pure domain → snake_case mappers (layered-architecture §3.7). */
export const CountryMapper = {
  toResponse(row: CountryRow): CountryResponse {
    return { code: row.code, name: row.name, calling_code: row.callingCode };
  },
  toList(rows: CountryRow[]): CountryResponse[] {
    return rows.map(CountryMapper.toResponse);
  },
};

export const CurrencyMapper = {
  toResponse(row: CurrencyRow): CurrencyResponse {
    return { code: row.code, name: row.name, symbol: row.symbol };
  },
  toList(rows: CurrencyRow[]): CurrencyResponse[] {
    return rows.map(CurrencyMapper.toResponse);
  },
};