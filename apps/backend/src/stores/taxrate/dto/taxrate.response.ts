/** Tax-rate wire contract (snake_case). `rate_percent` stays a string to
 *  preserve the exact `numeric(6,3)` value — never a JS float. `row_version`
 *  is the optimistic-lock token to round-trip on edit. */
export interface TaxRateResponse {
  id:           string;
  name:         string;
  rate_percent: string;
  is_inclusive: boolean;
  is_active:    boolean;
  guuid:        string;
  row_version:  number;
}
