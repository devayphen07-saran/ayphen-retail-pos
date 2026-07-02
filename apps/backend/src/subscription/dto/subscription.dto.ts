import { z } from 'zod';

/** POST /me/account/subscription/checkout */
export const CheckoutDtoSchema = z.object({
  plan_code: z.string().min(1).max(60),
});
export type CheckoutDto = z.infer<typeof CheckoutDtoSchema>;

/** POST /me/account/subscription/verify */
export const VerifyPaymentDtoSchema = z.object({
  order_id:   z.string().min(1),
  payment_id: z.string().min(1),
  signature:  z.string().min(1),
});
export type VerifyPaymentDto = z.infer<typeof VerifyPaymentDtoSchema>;
