import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { NotFoundError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { parse } from '#common/validation/parse.js';
import { MobileJwtGuard } from '#auth/mobile/guards/mobile-jwt.guard.js';
import { StepUpAuthGuard } from '#common/rbac/guards/step-up-auth.guard.js';
import { CurrentUser, StepUpAuth, StoreContext } from '#common/rbac/decorators/rbac.decorators.js';
import type { MobilePrincipal } from '#auth/mobile/types/mobile-principal.js';
import { SubscriptionService } from './subscription.service.js';
import { BillingService } from './billing.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import { SubscriptionResponseMapper } from './subscription.mapper.js';
import type {
  PlanCatalogEntry,
  SubscriptionActionResponse,
  SubscriptionVersionResponse,
  SubscriptionResponse,
  ReconciliationResponse,
  ReconciliationApplyResponse,
} from './dto/subscription.response.js';
import type { CheckoutResponse, VerifyPaymentResponse } from './dto/checkout.response.js';
import {
  CheckoutDtoSchema,
  VerifyPaymentDtoSchema,
  ReconciliationDtoSchema,
  ActiveStoreSwapDtoSchema,
} from './dto/subscription.dto.js';

/**
 * Account-scoped subscription + billing (subscription §9, §12, §13, §19).
 * MobileJwtGuard only — these are account-level, not store-scoped.
 * `StepUpAuthGuard` is applied class-wide but is a no-op on any route without
 * an explicit `@StepUpAuth` decorator (BR-020) — today that's only
 * cancel/reactivate; checkout/verify are owner-gated (see `BillingService`)
 * but do not require re-auth.
 */
@Controller('me')
@UseGuards(MobileJwtGuard, StepUpAuthGuard)
@StoreContext('none') // account-level surface — never store-scoped
export class MeSubscriptionController {
  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly billing: BillingService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  /** Purchasable plan catalog (static config; client caches ~24h). */
  @Get('subscription/plans')
  async getPlans(): Promise<PlanCatalogEntry[]> {
    const catalog = await this.subscriptions.getPlanCatalog();
    return SubscriptionResponseMapper.toPlanCatalog(catalog);
  }

  /** Full subscription read model — the freshness re-fetch target (§19). */
  @Get('subscription')
  async getSubscription(@CurrentUser() user: MobilePrincipal): Promise<SubscriptionResponse> {
    const view = await this.subscriptions.getViewForUser(user.userId);
    if (!view) throw new NotFoundError(ErrorCodes.SUBSCRIPTION_NOT_FOUND, 'Subscription not found');
    return SubscriptionResponseMapper.toResponse(view);
  }

  /**
   * Cheap poll target (§16) — just the version counter, so a client can decide
   * whether to pull the full `GET /me/subscription` payload without paying for
   * the plan/entitlement joins on every poll.
   */
  @Get('subscription/sv')
  async getSubscriptionVersion(
    @CurrentUser() user: MobilePrincipal,
  ): Promise<SubscriptionVersionResponse> {
    const version = await this.subscriptions.getVersionForUser(user.userId);
    if (version === null) throw new NotFoundError(ErrorCodes.SUBSCRIPTION_NOT_FOUND, 'Subscription not found');
    return SubscriptionResponseMapper.toVersionResponse(version);
  }

  /** Create a payment order for a plan (§9). Owner-gated only — no step-up
   *  (product decision: checkout/verify don't require re-auth, unlike
   *  cancel/reactivate below). */
  @Post('account/subscription/checkout')
  async checkout(
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<CheckoutResponse> {
    const dto = parse(body, CheckoutDtoSchema);
    const result = await this.billing.checkout(user.userId, dto.plan_code);
    return SubscriptionResponseMapper.toCheckoutResponse(result);
  }

  /** Verify a client-reported payment → activate (§9). Owner-gated only — see
   *  `checkout` above for why this doesn't require step-up. */
  @Post('account/subscription/verify')
  async verify(
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<VerifyPaymentResponse> {
    const dto = parse(body, VerifyPaymentDtoSchema);
    const result = await this.billing.verify(user.userId, {
      orderId:   dto.order_id,
      paymentId: dto.payment_id,
      signature: dto.signature,
    });
    return SubscriptionResponseMapper.toVerifyResponse(result);
  }

  /** Request cancellation at period end (§12). Owner + step-up. */
  @Post('subscription/cancel')
  @StepUpAuth({ within: '5m' })
  async cancel(@CurrentUser() user: MobilePrincipal): Promise<SubscriptionActionResponse> {
    const sub = await this.subscriptions.cancel(user.userId);
    return SubscriptionResponseMapper.toActionResponse(sub);
  }

  /** Undo a pending cancellation, still within the paid period (§13 case A). Owner + step-up. */
  @Post('subscription/reactivate')
  @StepUpAuth({ within: '5m' })
  async reactivate(@CurrentUser() user: MobilePrincipal): Promise<SubscriptionActionResponse> {
    const sub = await this.subscriptions.reactivate(user.userId);
    return SubscriptionResponseMapper.toActionResponse(sub);
  }

  /**
   * The downgrade resolve screen's data — every store/location/device the
   * owner can choose to keep, plus the plan's new limits. Meaningful only
   * while `reconciliation_status='pending'`, but always safe to call (an
   * account with nothing over limit just returns everything active).
   */
  @Get('subscription/reconciliation')
  async getReconciliation(@CurrentUser() user: MobilePrincipal): Promise<ReconciliationResponse> {
    const ctx = await this.reconciliation.getContextForUser(user.userId, user.deviceId);
    return SubscriptionResponseMapper.toReconciliationResponse(ctx);
  }

  /**
   * The owner's downgrade resolution (§15D, device-management §19). Owner +
   * step-up, same bar as cancel/reactivate — this locks/revokes real store
   * access, not a cosmetic setting.
   */
  @Post('subscription/reconciliation')
  @StepUpAuth({ within: '5m' })
  async resolveReconciliation(
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<ReconciliationApplyResponse> {
    const dto = parse(body, ReconciliationDtoSchema);
    await this.reconciliation.applyForUser(user.userId, user.deviceId, {
      keepStoreIds:    dto.keep_store_ids,
      keepLocationIds: dto.keep_location_ids,
      keepDeviceIds:   dto.keep_device_ids,
    });
    return SubscriptionResponseMapper.toAppliedResponse();
  }

  /**
   * Post-downgrade flexibility (§8): swap which store is active without
   * redoing the full resolve flow. Owner + step-up, same bar as the resolve
   * endpoint above — this locks/revokes real store access.
   */
  @Post('subscription/active-store')
  @StepUpAuth({ within: '5m' })
  async swapActiveStore(
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<ReconciliationApplyResponse> {
    const dto = parse(body, ActiveStoreSwapDtoSchema);
    await this.reconciliation.swapActiveStoreForUser(user.userId, {
      activateStoreId:   dto.activate_store_id,
      deactivateStoreId: dto.deactivate_store_id,
      keepLocationIds:   dto.keep_location_ids,
      keepDeviceIds:     dto.keep_device_ids,
    });
    return SubscriptionResponseMapper.toAppliedResponse();
  }
}
