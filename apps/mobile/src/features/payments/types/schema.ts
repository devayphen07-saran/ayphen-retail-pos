import { z } from 'zod';

/** Create form for a payment account (PRD payment-accounts-mobile §IS-3).
 *  Name mirrors the server rule (BR-5): trimmed, 1–60 chars. Kind + default are
 *  optional. `reference` is an optional, kind-agnostic identifier (account no. /
 *  UPI ID / last 4) — bounded to 140 to mirror the server `details` schema. */
export const createPaymentAccountSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(60, 'Keep it under 60 characters'),
  kind: z.enum(['cash', 'bank', 'upi', 'card', 'wallet', 'other']).optional(),
  reference: z.string().trim().max(140, 'Keep it under 140 characters').optional(),
  setDefault: z.boolean().optional(),
});

export type CreatePaymentAccountForm = z.infer<typeof createPaymentAccountSchema>;

export const DEFAULT_CREATE_PAYMENT_ACCOUNT_VALUES: CreatePaymentAccountForm = {
  name: '',
  kind: undefined,
  reference: '',
  setDefault: false,
};
