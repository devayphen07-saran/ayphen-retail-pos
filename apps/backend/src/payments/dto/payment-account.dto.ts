import { z } from 'zod';
import {
  PAYMENT_ACCOUNT_KINDS,
  PaymentAccountDetailsSchema,
} from '../../sync/push/handlers/payment-account.handler.js';

/** Create a payment account (management REST surface). `guuid` is generated
 *  server-side; `is_system`/`system_key` are never client-settable (DR-7).
 *  `details` reuses the sync-push handler's bounded schema so the REST and
 *  offline write paths enforce the identical shape. */
export const CreatePaymentAccountDtoSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(PAYMENT_ACCOUNT_KINDS).optional(),
  details: PaymentAccountDetailsSchema,
  is_default: z.boolean().optional(),
});
export type CreatePaymentAccountDto = z.infer<typeof CreatePaymentAccountDtoSchema>;

/** Edit a payment account. `expected_row_version` guards against a concurrent
 *  edit (optimistic lock, same contract as roles). */
export const UpdatePaymentAccountDtoSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  kind: z.enum(PAYMENT_ACCOUNT_KINDS).optional(),
  details: PaymentAccountDetailsSchema,
  is_default: z.boolean().optional(),
  is_active: z.boolean().optional(),
  expected_row_version: z.number().int().positive(),
});
export type UpdatePaymentAccountDto = z.infer<typeof UpdatePaymentAccountDtoSchema>;
