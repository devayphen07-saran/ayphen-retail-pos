import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { parse } from '#common/validation/parse.js';
import { MobileJwtGuard } from '#auth/mobile/guards/mobile-jwt.guard.js';
import { StepUpAuthGuard } from '#common/rbac/guards/step-up-auth.guard.js';
import { CurrentUser, StepUpAuth, StoreContext } from '#common/rbac/decorators/rbac.decorators.js';
import type { MobilePrincipal } from '#auth/mobile/types/mobile-principal.js';
import { SubscriptionService } from './subscription.service.js';
import { BillingService } from './billing.service.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { SubscriptionResponseMapper } from './subscription.mapper.js';
import type { SubscriptionResponse } from './dto/subscription.response.js';
import {
  CheckoutDtoSchema,
  VerifyPaymentDtoSchema,
} from './dto/subscription.dto.js';

/**
 * Account-scoped subscription + billing (subscription §9, §12, §13, §19).
 * MobileJwtGuard only — these are account-level, not store-scoped. Billing
 * mutations additionally require recent step-up (BR-020) via StepUpAuthGuard.
 */
@Controller('me')
@UseGuards(MobileJwtGuard, StepUpAuthGuard)
@StoreContext('none') // account-level surface — never store-scoped
export class MeSubscriptionController {
  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly billing: BillingService,
    private readonly repo: SubscriptionRepository,
  ) {}

  /** Full subscription read model — the freshness re-fetch target (§19). */
  @Get('subscription')
  async getSubscription(@CurrentUser() user: MobilePrincipal): Promise<SubscriptionResponse> {
    const view = await this.subscriptions.getViewForUser(user.userId);
    if (!view) throw new NotFoundException('SUBSCRIPTION_NOT_FOUND');
    return SubscriptionResponseMapper.toResponse(view);
  }

  /** Create a payment order for a plan (§9). Owner + step-up. */
  @Post('account/subscription/checkout')
  @StepUpAuth({ within: '5m' })
  async checkout(
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const dto = parse(body, CheckoutDtoSchema);
    const prefill = await this.repo.findBillingPrefill(user.userId);
    return this.billing.checkout(user.userId, dto.plan_code, prefill);
  }

  /** Verify a client-reported payment → activate (§9). Owner + step-up. */
  @Post('account/subscription/verify')
  @StepUpAuth({ within: '5m' })
  async verify(
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<{ activated: boolean }> {
    const dto = parse(body, VerifyPaymentDtoSchema);
    return this.billing.verify(user.userId, {
      orderId:   dto.order_id,
      paymentId: dto.payment_id,
      signature: dto.signature,
    });
  }

}
