import type { PaymentAccountDetails } from '../types/payment-account.types.js';

export interface PaymentAccountResponse {
  /** Public identifier — the internal row id is never exposed to clients (#10). */
  guuid: string;
  name: string;
  /** Channel: cash | bank | upi | card | wallet | other. */
  kind: string;
  details: PaymentAccountDetails | null;
  is_default: boolean;
  is_active: boolean;
  /** Seeded Cash/Bank: only the default status can be changed. */
  is_system: boolean;
  system_key: string | null;
  row_version: number;
}
