import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type {
  PaymentProvider,
  CreateOrderInput,
  CreateOrderResult,
  VerifyPaymentInput,
  VerifyPaymentResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from './payment-provider.js';

/** Shared secret used to make Fake signatures deterministic and verifiable. */
const FAKE_SECRET = 'fake-payment-secret';

/** Fake webhook body — mirrors the fields the fake flow emits. */
const FakeWebhookBodySchema = z.object({
  event:      z.string().optional(),
  order_id:   z.string().optional(),
  payment_id: z.string().optional(),
  reason:     z.string().optional(),
});

/**
 * Deterministic in-memory provider used when no real gateway is configured (dev,
 * tests, no keys). Signs with a fixed secret using the same HMAC-SHA256 scheme as
 * Razorpay (`order|payment`) so the full checkout→verify→webhook→activate flow is
 * exercisable end-to-end without an external dependency.
 */
@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const orderId = `order_fake_${input.idempotencyKey}`;
    return {
      orderId,
      clientPayload: {
        provider: 'fake',
        key:      'fake_key',
        order_id: orderId,
        amount:   input.amount,
        currency: input.currency,
      },
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const expected = this.sign(`${input.orderId}|${input.paymentId}`);
    return { ok: expected === input.signature, providerRef: input.paymentId };
  }

  verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
    const expected = this.sign(input.rawBody.toString('utf8'));
    if (expected !== input.signatureHeader) {
      return { ok: false, event: { type: 'ignored' } };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(input.rawBody.toString('utf8'));
    } catch {
      return { ok: true, event: { type: 'ignored' } };
    }
    const parsed = FakeWebhookBodySchema.safeParse(raw);
    if (!parsed.success) return { ok: true, event: { type: 'ignored' } };
    const body = parsed.data;
    if (body.event === 'payment.captured' && body.order_id) {
      return { ok: true, event: { type: 'payment.succeeded', orderId: body.order_id, providerRef: body.payment_id ?? '' } };
    }
    if (body.event === 'payment.failed' && body.order_id) {
      return { ok: true, event: { type: 'payment.failed', orderId: body.order_id, reason: body.reason } };
    }
    return { ok: true, event: { type: 'ignored' } };
  }

  /** Exposed so tests can produce valid signatures for the fake flow. */
  sign(data: string): string {
    return createHmac('sha256', FAKE_SECRET).update(data).digest('hex');
  }
}
