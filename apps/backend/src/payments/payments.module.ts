import { Module } from '@nestjs/common';
import { MobileAuthModule } from '#auth/mobile/mobile-auth.module.js';
import { SubscriptionStatusGuard } from '#auth/mobile/guards/subscription-status.guard.js';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { PaymentAccountController } from './payment-account.controller.js';
import { PaymentAccountService } from './payment-account.service.js';
import { PaymentAccountRepository } from './payment-account.repository.js';

/**
 * Online REST surface for payment-account management. Imports SyncModule to
 * reuse the exported PaymentAccountMutationHandler (identical write rules —
 * PRD payment-accounts-mobile §DR-6); the offline read path lives in SyncModule.
 */
@Module({
  imports: [MobileAuthModule, SubscriptionModule, SyncModule],
  controllers: [PaymentAccountController],
  providers: [PaymentAccountService, PaymentAccountRepository, SubscriptionStatusGuard],
})
export class PaymentsModule {}
