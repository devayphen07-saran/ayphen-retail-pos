/**
 * POST /me/subscription/checkout response. Both bound providers
 * (Razorpay, Fake) populate exactly these fields via createOrder's
 * clientPayload; a future provider needing a different shape is a deliberate
 * change to this DTO + the mapper, not an open bag on the wire (§3.7).
 */
export interface CheckoutResponse {
  provider: string;
  key:      string;
  order_id: string;
  amount:   number;
  currency: string;
  prefill:  { name: string; contact: string };
}

/** POST /me/subscription/verify response. */
export interface VerifyPaymentResponse {
  activated: boolean;
}
