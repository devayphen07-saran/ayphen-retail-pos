import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '#config/app-config.service.js';
import type {
  PaymentProvider,
  CreateOrderInput,
  CreateOrderResult,
  VerifyPaymentInput,
  VerifyPaymentResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
  PaymentEvent,
} from './payment-provider.js';

/**
 * Razorpay adapter. Signature verification (checkout + webhook) is real and
 * complete — HMAC-SHA256 exactly as Razorpay specifies. The outbound
 * order-create call is isolated in `callOrderApi()` behind this seam: with live
 * keys it hits the REST API; without, it throws so the app fails loud rather
 * than silently pretending. (In practice PAYMENT_PROVIDER binds to the Fake
 * provider when keys are absent — see the module.)
 */
@Injectable()
export class RazorpayPaymentProvider implements PaymentProvider {
  readonly name = 'razorpay';

  constructor(private readonly config: AppConfigService) {}

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const keyId = this.config.razorpayKeyId;
    const order = await this.callOrderApi(input);
    return {
      orderId: order.id,
      clientPayload: {
        provider: 'razorpay',
        key:      keyId,
        order_id: order.id,
        amount:   input.amount,
        currency: input.currency,
      },
    };
  }

  /** Verify the client callback: HMAC-SHA256 over `order_id|payment_id`. */
  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const expected = createHmac('sha256', this.config.razorpayKeySecret)
      .update(`${input.orderId}|${input.paymentId}`)
      .digest('hex');
    return { ok: this.safeEqual(expected, input.signature), providerRef: input.paymentId };
  }

  /** Verify a webhook: HMAC-SHA256 over the raw request body with the webhook secret. */
  verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
    const expected = createHmac('sha256', this.config.razorpayWebhookSecret)
      .update(input.rawBody)
      .digest('hex');
    if (!this.safeEqual(expected, input.signatureHeader)) {
      return { ok: false, event: { type: 'ignored' } };
    }
    return { ok: true, event: this.normalizeWebhook(input.rawBody) };
  }

  private normalizeWebhook(rawBody: Buffer): PaymentEvent {
    const body = JSON.parse(rawBody.toString('utf8')) as {
      event?: string;
      payload?: { payment?: { entity?: { order_id?: string; id?: string; error_description?: string } } };
    };
    const entity = body.payload?.payment?.entity;
    const orderId = entity?.order_id;
    if (!orderId) return { type: 'ignored' };

    if (body.event === 'payment.captured') {
      return { type: 'payment.succeeded', orderId, providerRef: entity?.id ?? '' };
    }
    if (body.event === 'payment.failed') {
      return { type: 'payment.failed', orderId, reason: entity?.error_description };
    }
    return { type: 'ignored' };
  }

  /**
   * Outbound Razorpay Orders API call — POST /v1/orders with HTTP basic auth
   * (keyId:keySecret). `receipt` is set to the idempotency key so Razorpay dedupes
   * retried creates for the same account+plan. Returns the created order id.
   * https://razorpay.com/docs/api/orders/create/
   */
  private async callOrderApi(input: CreateOrderInput): Promise<{ id: string }> {
    const auth = Buffer.from(
      `${this.config.razorpayKeyId}:${this.config.razorpayKeySecret}`,
    ).toString('base64');

    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount:   input.amount,
        currency: input.currency,
        receipt:  input.idempotencyKey,
        notes:    { accountId: input.accountId, planCode: input.planCode },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`RAZORPAY_ORDER_CREATE_FAILED (${res.status}): ${detail.slice(0, 300)}`);
    }

    const order = (await res.json()) as { id?: string };
    if (!order.id) throw new Error('RAZORPAY_ORDER_CREATE_NO_ID');
    return { id: order.id };
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
