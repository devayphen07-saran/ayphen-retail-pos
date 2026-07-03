import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { MOBILE_REDIS } from '#auth/mobile/services/redis.provider.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { SubscriptionService } from './subscription.service.js';
import { PAYMENT_PROVIDER, type PaymentProvider, type PaymentEvent } from './payment/payment-provider.js';
import { resolvePlanPrice } from './payment/plan-pricing.js';

/** Redis map: order id → the account+plan it was created for. Verify/webhook read it. */
const orderKey = (orderId: string) => `pay:order:${orderId}`;
const ORDER_TTL_SECONDS = 3600; // 1h — covers the checkout→verify/webhook window.
/** Idempotency marker: an order already activated is a no-op on retry. */
const doneKey = (orderId: string) => `pay:done:${orderId}`;
const DONE_TTL_SECONDS = 86_400;

interface PendingOrder {
  accountId: string;
  planFk:    string;
}

/**
 * Orchestrates the payment flow over the provider-agnostic PaymentProvider port
 * (subscription §9). Billing actions are gated on account ownership. Activation
 * is idempotent across the retried `verify` call and the `payment.captured`
 * webhook — both key on the order id.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly repo: SubscriptionRepository,
    private readonly subscriptions: SubscriptionService,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
    @Inject(MOBILE_REDIS) private readonly redis: Redis,
  ) {}

  /** Create a payment order for a plan. Owner-gated. Returns the client SDK payload. */
  async checkout(
    userId: string,
    planCode: string,
    prefill: { name: string; contact: string },
  ): Promise<Record<string, unknown>> {
    const accountId = await this.requireOwnedAccount(userId);

    const price = resolvePlanPrice(planCode);
    if (!price) throw new UnprocessableEntityException('UNKNOWN_PLAN_CODE');

    const planFk = await this.repo.findPlanIdByName(price.planName);
    if (!planFk) throw new UnprocessableEntityException('PLAN_NOT_CONFIGURED');

    const order = await this.payments.createOrder({
      amount:   price.amount,
      currency: price.currency,
      accountId,
      planCode,
      idempotencyKey: `${accountId}:${planCode}`,
    });

    const pending: PendingOrder = { accountId, planFk };
    await this.redis.set(orderKey(order.orderId), JSON.stringify(pending), 'EX', ORDER_TTL_SECONDS);

    return { ...order.clientPayload, prefill };
  }

  /** Verify a client-reported payment and activate. Owner-gated + signature-checked. */
  async verify(
    userId: string,
    input: { orderId: string; paymentId: string; signature: string },
  ): Promise<{ activated: boolean }> {
    await this.requireOwnedAccount(userId);

    const result = await this.payments.verifyPayment(input);
    if (!result.ok) throw new ForbiddenException('PAYMENT_SIGNATURE_INVALID');

    await this.applySuccess(input.orderId, result.providerRef);
    return { activated: true };
  }

  /** Handle a provider webhook (authoritative backstop). No auth beyond signature. */
  async handleWebhook(rawBody: Buffer, signatureHeader: string): Promise<{ handled: boolean }> {
    const { ok, event } = this.payments.verifyWebhook({ rawBody, signatureHeader });
    if (!ok) throw new ForbiddenException('WEBHOOK_SIGNATURE_INVALID');
    await this.dispatch(event);
    return { handled: true };
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private async dispatch(event: PaymentEvent): Promise<void> {
    if (event.type === 'payment.succeeded') {
      await this.applySuccess(event.orderId, event.providerRef);
    }
    // payment.failed / ignored → no state change. Without recurrence there is no
    // past_due lapse; the account stays as-is and the owner can simply retry.
  }

  /** Idempotent activation: first caller (verify OR webhook) wins; retries no-op. */
  private async applySuccess(orderId: string, providerRef: string): Promise<void> {
    const claimed = await this.redis.set(doneKey(orderId), '1', 'EX', DONE_TTL_SECONDS, 'NX');
    if (!claimed) return; // already activated for this order

    const pending = await this.readOrder(orderId);
    if (!pending) {
      // Order context expired/unknown — release the claim so a later retry (with
      // context restored) can still activate.
      await this.redis.del(doneKey(orderId));
      throw new NotFoundException('PAYMENT_ORDER_NOT_FOUND');
    }

    await this.subscriptions.activateFromPayment(pending.accountId, pending.planFk, providerRef);
    await this.redis.del(orderKey(orderId));
  }

  private async readOrder(orderId: string): Promise<PendingOrder | null> {
    const raw = await this.redis.get(orderKey(orderId));
    return raw ? (JSON.parse(raw) as PendingOrder) : null;
  }

  private async requireOwnedAccount(userId: string): Promise<string> {
    const accountId = await this.repo.findOwnedAccountId(userId);
    if (!accountId) throw new ForbiddenException('NOT_ACCOUNT_OWNER');
    return accountId;
  }
}
