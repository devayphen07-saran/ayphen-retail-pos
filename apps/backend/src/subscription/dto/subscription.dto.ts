import { z } from 'zod';

/** POST /me/account/subscription/checkout */
export const CheckoutDtoSchema = z.object({
  plan_code: z.string().min(1).max(60),
});
export type CheckoutDto = z.infer<typeof CheckoutDtoSchema>;

/** POST /me/account/subscription/verify */
export const VerifyPaymentDtoSchema = z.object({
  order_id:   z.string().min(1).max(100),
  payment_id: z.string().min(1).max(100),
  signature:  z.string().min(1).max(128),
});
export type VerifyPaymentDto = z.infer<typeof VerifyPaymentDtoSchema>;

/** POST /me/subscription/reconciliation — the owner's downgrade resolution. */
export const ReconciliationDtoSchema = z.object({
  keep_store_ids:    z.array(z.string().uuid()),
  keep_device_ids:   z.array(z.string().uuid()),
});
export type ReconciliationDto = z.infer<typeof ReconciliationDtoSchema>;

/** POST /me/subscription/active-store — post-downgrade swap (reconciliation §8). */
export const ActiveStoreSwapDtoSchema = z.object({
  activate_store_id:   z.string().uuid(),
  deactivate_store_id: z.string().uuid(),
  keep_device_ids:     z.array(z.string().uuid()),
});
export type ActiveStoreSwapDto = z.infer<typeof ActiveStoreSwapDtoSchema>;
