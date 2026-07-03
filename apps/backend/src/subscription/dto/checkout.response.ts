/**
 * POST /me/account/subscription/checkout response. The provider-specific fields
 * (key id, order id, etc.) come from PaymentProvider.createOrder's clientPayload —
 * intentionally open-ended so swapping providers doesn't require a DTO change.
 */
export interface CheckoutResponse {
  prefill: { name: string; contact: string };
  [key: string]: unknown;
}

/** POST /me/account/subscription/verify response. */
export interface VerifyPaymentResponse {
  activated: boolean;
}
