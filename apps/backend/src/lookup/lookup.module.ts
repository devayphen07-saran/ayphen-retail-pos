import { Module } from '@nestjs/common';
import { LookupController } from './lookup.controller.js';
import { LookupTypeController } from './lookup-type.controller.js';
import { LookupValuesController } from './lookup-values.controller.js';
import { LookupService } from './lookup.service.js';
import { LookupRepository } from './lookup.repository.js';
import { LookupTypeRepository } from './lookup-type.repository.js';
import { SubscriptionStatusGuard } from '#auth/mobile/guards/subscription-status.guard.js';
import { MobileAuthModule } from '#auth/mobile/mobile-auth.module.js';

/**
 * Lookup engine (lookup-entity-prd.md §6, P2): user-extensible, store-scoped
 * dropdown values (PAYMENT_TERMS, REASONS, …). RbacService/SuperAdminGuard's
 * RbacRepository dep, UnitOfWork, DRIZZLE come from global modules;
 * MobileJwtGuard (module-scoped deps) from MobileAuthModule.
 */
@Module({
  imports: [MobileAuthModule],
  controllers: [LookupController, LookupTypeController, LookupValuesController],
  providers: [LookupService, LookupRepository, LookupTypeRepository, SubscriptionStatusGuard],
})
export class LookupModule {}
