/**
 * Provider-agnostic payment port. Razorpay/Stripe/etc. are adapters bound to the
 * PAYMENT_PROVIDER token; subscription logic depends only on this interface and
 * the normalized PaymentEvent, so switching providers is one binding change.
 */

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface CreateOrderInput {
  amount: number; // minor units (paise)
  currency: string; // 'INR'
  accountId: string;
  planCode: string;
  idempotencyKey: string; // dedupe retried checkout calls
}

export interface CreateOrderResult {
  orderId: string;
  /** Whatever the client SDK needs to launch checkout (key id, order id, prefill…). */
  clientPayload: Record<string, unknown>;
}

export interface VerifyPaymentInput {
  orderId: string;
  paymentId: string;
  signature: string;
}

export interface VerifyPaymentResult {
  ok: boolean;
  providerRef: string; // payment id we store as the activation reference
}

export interface VerifyWebhookInput {
  rawBody: Buffer;
  signatureHeader: string;
}

/** Normalized, provider-independent billing event the subscription layer reacts to. */
export type PaymentEvent =
  | { type: 'payment.succeeded'; orderId: string; providerRef: string; amount?: number; currency?: string }
  | { type: 'payment.failed'; orderId: string; reason?: string }
  | { type: 'ignored' };

export interface VerifyWebhookResult {
  ok: boolean; // signature valid
  event: PaymentEvent;
}

export interface PaymentProvider {
  readonly name: string;

  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult>;
  verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult;
}
