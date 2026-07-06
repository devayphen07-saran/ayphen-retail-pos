import { Injectable } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ServiceUnavailableError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
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

/** Razorpay webhook envelope — only the fields we consume, all optional/validated. */
const WebhookBodySchema = z.object({
  event: z.string().optional(),
  payload: z
    .object({
      payment: z
        .object({
          entity: z
            .object({
              order_id:          z.string().optional(),
              id:                z.string().optional(),
              amount:            z.number().optional(),
              currency:          z.string().optional(),
              error_description: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

/** Razorpay Orders API create response — we require an `id`. */
const OrderCreateResponseSchema = z.object({ id: z.string() });

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
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { type: 'ignored' };
    }
    const parsed = WebhookBodySchema.safeParse(raw);
    if (!parsed.success) return { type: 'ignored' };
    const body = parsed.data;
    const entity = body.payload?.payment?.entity;
    const orderId = entity?.order_id;
    if (!orderId) return { type: 'ignored' };

    if (body.event === 'payment.captured') {
      return {
        type: 'payment.succeeded',
        orderId,
        providerRef: entity?.id ?? '',
        amount: entity?.amount,
        currency: entity?.currency,
      };
    }
    if (body.event === 'payment.failed') {
      return { type: 'payment.failed', orderId, reason: entity?.error_description };
    }
    return { type: 'ignored' };
  }

  /**
   * Outbound Razorpay Orders API call — POST /v1/orders with HTTP basic auth
   * (keyId:keySecret). `receipt` is set to a hash of the idempotency key so
   * Razorpay dedupes retried creates for the same account+plan — Razorpay
   * caps `receipt` at 40 chars, and the raw idempotency key
   * (`{accountId-uuid}:{planCode}`) regularly exceeds that, which is what
   * `RAZORPAY_ORDER_CREATE_FAILED (400): receipt: the length must be no more
   * than 40` means if you see it. Hashing (not truncating) keeps the
   * dedup property: same input always produces the same receipt regardless
   * of where in the string the entropy that made it unique was.
   * https://razorpay.com/docs/api/orders/create/
   */
  private async callOrderApi(input: CreateOrderInput): Promise<{ id: string }> {
    const auth = Buffer.from(
      `${this.config.razorpayKeyId}:${this.config.razorpayKeySecret}`,
    ).toString('base64');
    const receipt = createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 40);

    const body = JSON.stringify({
      amount:   input.amount,
      currency: input.currency,
      receipt,
      notes:    { accountId: input.accountId, planCode: input.planCode },
    });

    const res = await this.postOrder(body, auth);

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ServiceUnavailableError(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'Failed to create payment order with the provider',
        { status: res.status, detail: detail.slice(0, 300) },
      );
    }

    const parsed = OrderCreateResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new ServiceUnavailableError(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'Payment provider returned no order id',
      );
    }
    return { id: parsed.data.id };
  }

  /**
   * POST to Razorpay with a hard per-attempt timeout and a small bounded retry
   * on network error / timeout / 5xx. A hung gateway must not pin the checkout
   * request for undici's ~300s default — the 30s app timeout 408s the client
   * but never aborts this socket.
   */
  private async postOrder(body: string, auth: string): Promise<Awaited<ReturnType<typeof fetch>>> {
    const TIMEOUT_MS = 8_000;
    const ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      try {
        const res = await fetch('https://api.razorpay.com/v1/orders', {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
          body,
          signal: ac.signal,
        });
        // Retry only transient server-side failures; 4xx is a real error, return it.
        if (res.status >= 500 && attempt < ATTEMPTS) { lastErr = new Error(`razorpay ${res.status}`); continue; }
        return res;
      } catch (err) {
        lastErr = err;
        if (attempt >= ATTEMPTS) break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ServiceUnavailableError(
      ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
      'The payment provider is currently unreachable',
      { detail: lastErr instanceof Error ? lastErr.message : String(lastErr) },
    );
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
