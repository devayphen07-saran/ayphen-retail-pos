import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableError,
} from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import type { Redis } from 'ioredis';
import { z, type ZodType } from 'zod';
import { REDIS } from '#common/redis/redis.provider.js';
import { readTypedCache } from '#common/redis/typed-cache.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { SubscriptionService } from './subscription.service.js';
import { RateLimitService } from '#auth/core/rate-limit.service.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type PaymentEvent,
  type CreateOrderResult,
} from './payment/payment-provider.js';
import { resolvePlanPrice, type PlanPrice } from './payment/plan-pricing.js';

/** camelCase domain result of a checkout order (mapper shapes the wire). */
export interface CheckoutResult {
  /** Provider-specific client SDK payload (key id, order id, …). Open-ended. */
  clientPayload: Record<string, unknown>;
  prefill:       { name: string; contact: string };
}

/** camelCase domain result of a payment verification. */
export interface VerifyResult {
  activated: boolean;
}

/** Redis map: order id → the account+plan it was created for. Verify/webhook read it. */
const orderKey = (orderId: string) => `pay:order:${orderId}`;
const ORDER_TTL_SECONDS = 3600; // 1h — covers the checkout→verify/webhook window.
interface PendingOrder {
  accountId: string;
  planFk:    string;
  planCode:  string;
}

const PendingOrderSchema: ZodType<PendingOrder> = z.object({
  accountId: z.string(),
  planFk: z.string(),
  planCode: z.string(),
});

/**
 * Orchestrates the payment flow over the provider-agnostic PaymentProvider port
 * (subscription §9). Billing actions are gated on account ownership. Activation
 * is idempotent across the retried `verify` call and the `payment.captured`
 * webhook — both key on the order id.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly repo: SubscriptionRepository,
    private readonly subscriptions: SubscriptionService,
    private readonly rateLimit: RateLimitService,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Create a payment order for a plan. Owner-gated. Returns the client SDK payload. */
  async checkout(
    userId: string,
    planCode: string,
  ): Promise<CheckoutResult> {
    const accountId = await this.repo.requireOwnedAccountId(userId);

    // Identity-scoped limit — checkout triggers a real outbound Razorpay
    // Orders API call (with its own retries) per invocation, and the global
    // per-IP throttler alone is a DDoS backstop, not an abuse control (see
    // ThrottleModule's comment) — a single carrier-NAT IP is thousands of
    // legitimate users. 10 checkout attempts per account per 5 minutes is
    // generous for legitimate retry/plan-comparison flows.
    await this.rateLimit.checkAccountActionLimit(accountId, 'checkout', 300, 10);

    const prefill = await this.repo.findBillingPrefill(userId);

    const price = resolvePlanPrice(planCode);
    if (!price) throw new UnprocessableError(ErrorCodes.UNKNOWN_PLAN_CODE, 'Unknown plan code');

    const planFk = await this.repo.findPlanIdByName(price.planName);
    if (!planFk) throw new UnprocessableError(ErrorCodes.PLAN_NOT_CONFIGURED, 'This plan is not configured');

    const order = await this.createOrder(price, accountId, planCode);

    // Durable copy first — this is what a late webhook (arriving after the
    // Redis key below has expired) will fall back to in readOrder(). Redis
    // stays as the fast path for the common case.
    await this.repo.insertPaymentOrder(order.orderId, accountId, planFk, planCode);

    const pending: PendingOrder = { accountId, planFk, planCode };
    await this.redis.set(orderKey(order.orderId), JSON.stringify(pending), 'EX', ORDER_TTL_SECONDS);

    return { clientPayload: order.clientPayload, prefill };
  }

  /** Verify a client-reported payment and activate. Owner-gated + signature-checked. */
  async verify(
    userId: string,
    input: { orderId: string; paymentId: string; signature: string },
  ): Promise<VerifyResult> {
    const accountId = await this.repo.requireOwnedAccountId(userId);

    // Bind the order to the caller — the order's account must be the caller's
    // own. Without this the owner-check was dead code (its result was discarded).
    const pending = await this.readOrder(input.orderId);
    if (!pending || pending.accountId !== accountId) {
      throw new NotFoundError(ErrorCodes.PAYMENT_ORDER_NOT_FOUND, 'Payment order not found');
    }

    const result = await this.payments.verifyPayment(input);
    if (!result.ok) throw new ForbiddenError(ErrorCodes.PAYMENT_SIGNATURE_INVALID, 'Payment signature is invalid');

    await this.applySuccess(input.orderId, result.providerRef);
    return { activated: true };
  }

  /** Handle a provider webhook (authoritative backstop). No auth beyond signature. */
  async handleWebhook(rawBody: Buffer, signatureHeader: string): Promise<{ handled: boolean }> {
    const { ok, event } = this.payments.verifyWebhook({ rawBody, signatureHeader });
    if (!ok) throw new ForbiddenError(ErrorCodes.WEBHOOK_SIGNATURE_INVALID, 'Webhook signature is invalid');
    await this.dispatch(event);
    return { handled: true };
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private async dispatch(event: PaymentEvent): Promise<void> {
    if (event.type === 'payment.succeeded') {
      await this.applySuccess(event.orderId, event.providerRef, {
        amount: event.amount,
        currency: event.currency,
      });
    }
    // payment.failed / ignored → no state change. Without recurrence there is no
    // past_due lapse; the account stays as-is and the owner can simply retry.
  }

  /**
   * Idempotent activation, crash-safe. The source of truth is the DB:
   * `activateFromPayment` transactionally claims `providerRef` in
   * `processed_payment_events` (ON CONFLICT DO NOTHING) in the SAME transaction
   * as the activation, so a duplicate delivery is a no-op and there is no way to
   * double-credit. The previous Redis `doneKey` NX gate has been removed: a hard
   * crash between the Redis claim and the DB commit could strand a *paid*
   * activation for the full claim TTL (every redelivery no-op'd against an
   * orphan key the crash never released).
   */
  private async applySuccess(
    orderId: string,
    providerRef: string,
    captured?: { amount?: number; currency?: string },
  ): Promise<void> {
    const pending = await this.readOrder(orderId);
    if (!pending) {
      throw new NotFoundError(ErrorCodes.PAYMENT_ORDER_NOT_FOUND, 'Payment order not found');
    }

    // Defence in depth: when the provider reports the captured amount, it MUST
    // match the price we set server-side. A dashboard/config drift that
    // under-charges is rejected, never silently activated.
    if (captured?.amount !== undefined) {
      const price = resolvePlanPrice(pending.planCode);
      if (
        !price ||
        captured.amount !== price.amount ||
        (captured.currency !== undefined && captured.currency.toUpperCase() !== price.currency.toUpperCase())
      ) {
        // AppExceptions are never logged by the global filter (only truly
        // unknown exceptions are) — without this, a real paid-but-stuck
        // customer produces zero server-side signal beyond a 422 the client
        // swallows. `error` (not `warn`) so a log-based alert rule can key on
        // it: this is either a price-config drift or a forged webhook, never
        // a routine client error.
        this.logger.error(
          `PAYMENT_AMOUNT_MISMATCH orderId=${orderId} accountId=${pending.accountId} ` +
          `planCode=${pending.planCode} expected=${price?.amount}${price?.currency} ` +
          `captured=${captured.amount}${captured.currency ?? ''} providerRef=${providerRef}`,
        );
        throw new UnprocessableError(ErrorCodes.PAYMENT_AMOUNT_MISMATCH, 'Captured amount does not match the plan price');
      }
    }

    await this.subscriptions.activateFromPayment(
      pending.accountId,
      pending.planFk,
      pending.planCode,
      orderId,
      providerRef,
    );
    try {
      await this.redis.del(orderKey(orderId));
    } catch {
      // Best-effort; TTL is the backstop (matches SubscriptionService/
      // ReconciliationService's invalidateCache) — the activation above
      // already committed, so a Redis blip here must not surface as a
      // failure to a customer who just paid successfully.
    }
  }

  /**
   * Redis first (fast path, covers the common checkout→verify/webhook window),
   * falling back to the durable `payment_orders` row when the 1h Redis TTL
   * has already lapsed — otherwise a webhook redelivered after that window
   * would find a valid idempotency claim to make but no data to act on.
   */
  private async readOrder(orderId: string): Promise<PendingOrder | null> {
    const cached = await readTypedCache(this.redis, orderKey(orderId), PendingOrderSchema);
    if (cached) return cached;

    const row = await this.repo.findPaymentOrder(orderId);
    return row ? { accountId: row.accountId, planFk: row.planFk, planCode: row.planCode } : null;
  }

  /**
   * The Razorpay adapter's outbound API call throws a plain Error on gateway
   * failure (razorpay-payment.provider.ts:callOrderApi) — the global filter
   * already keeps its detail server-side-only (no leakage), but without this
   * catch a gateway outage surfaces as a generic 500 indistinguishable from a
   * real server bug. Normalize it to a 503 so the client can tell "the
   * provider is down, retry" from "something is actually broken."
   */
  private async createOrder(
    price: PlanPrice,
    accountId: string,
    planCode: string,
  ): Promise<CreateOrderResult> {
    try {
      return await this.payments.createOrder({
        amount:   price.amount,
        currency: price.currency,
        accountId,
        planCode,
        idempotencyKey: `${accountId}:${planCode}`,
      });
    } catch {
      throw new ServiceUnavailableError(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'The payment provider is currently unavailable');
    }
  }
}
