/**
 * Wire types for the lookup / reference-data domain. Field names mirror the
 * backend response mappers (snake_case) exactly — see
 * `apps/backend/src/lookup/lookup-value.mapper.ts` and
 * `apps/backend/src/reference-data/reference-data.mapper.ts`.
 */

export interface LookupValueResponse {
  guuid: string;
  code: string;
  label: string;
  description: string | null;
  sort_order: number;
  is_system: boolean;
}

export interface CurrencyResponse {
  code: string;
  name: string;
  symbol: string;
}

export interface CountryResponse {
  code: string;
  name: string;
  calling_code: string | null;
}