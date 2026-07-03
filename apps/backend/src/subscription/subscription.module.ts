import { Module } from '@nestjs/common';
import { AppConfigService } from '#config/app-config.service.js';
import { AuthCoreModule } from '#auth/core/auth-core.module.js';
import { MobileAuthModule } from '#auth/mobile/mobile-auth.module.js';
import { EntitlementService } from './entitlement.service.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { SubscriptionService } from './subscription.service.js';
import { BillingService } from './billing.service.js';
import { SubscriptionReconciliationService } from './subscription-reconciliation.service.js';
import { MeSubscriptionController } from './me-subscription.controller.js';
import { RazorpayWebhookController } from './razorpay-webhook.controller.js';
import { PAYMENT_PROVIDER } from './payment/payment-provider.js';
import { FakePaymentProvider } from './payment/fake-payment.provider.js';
import { RazorpayPaymentProvider } from './payment/razorpay-payment.provider.js';

/**
 * Subscription lifecycle + billing (Phase B). The payment provider is chosen at
 * wiring time: Razorpay when its keys are configured, else the deterministic
 * Fake provider so the full flow is exercisable without a live gateway.
 * MobileJwtGuard + StepUpAuthGuard come from MobileAuthModule / global RbacModule.
 */
@Module({
  imports: [AuthCoreModule, MobileAuthModule],
  controllers: [MeSubscriptionController, RazorpayWebhookController],
  providers: [
    EntitlementService,
    SubscriptionRepository,
    SubscriptionService,
    BillingService,
    SubscriptionReconciliationService,
    FakePaymentProvider,
    RazorpayPaymentProvider,
    {
      provide: PAYMENT_PROVIDER,
      inject: [AppConfigService, RazorpayPaymentProvider, FakePaymentProvider],
      useFactory: (
        config: AppConfigService,
        razorpay: RazorpayPaymentProvider,
        fake: FakePaymentProvider,
      ) => (config.razorpayConfigured ? razorpay : fake),
    },
  ],
  exports: [EntitlementService, SubscriptionService, SubscriptionRepository],
})
export class SubscriptionModule {}
