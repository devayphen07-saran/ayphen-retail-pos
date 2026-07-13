/**
 * Wire types for the payment-accounts management surface (snake_case, mirroring
 * apps/backend/src/payments/dto/payment-account.response.ts).
 */

export type PaymentAccountKind = 'cash' | 'bank' | 'upi' | 'card' | 'wallet' | 'other';

/** Human-readable reference metadata (account no. / UPI ID / last 4). Bounded,
 *  display-only — never used in checkout routing. */
export interface PaymentAccountDetails {
  reference?: string;
}

export interface PaymentAccountResponse {
  /** Public identifier (the internal db id is not exposed). */
  guuid: string;
  name: string;
  kind: PaymentAccountKind;
  details: PaymentAccountDetails | null;
  is_default: boolean;
  is_active: boolean;
  is_system: boolean;
  system_key: string | null;
  row_version: number;
}

export interface CreatePaymentAccountRequest {
  name: string;
  kind?: PaymentAccountKind;
  details?: PaymentAccountDetails | null;
  is_default?: boolean;
}

export interface UpdatePaymentAccountRequest {
  name?: string;
  kind?: PaymentAccountKind;
  details?: PaymentAccountDetails | null;
  is_default?: boolean;
  is_active?: boolean;
  /** Optimistic-lock guard — the row_version the client last saw. */
  expected_row_version: number;
}
