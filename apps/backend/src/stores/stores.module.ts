import { Module } from '@nestjs/common';
import { StoreController } from './store/store.controller.js';
import { StoreService } from './store/store.service.js';
import { RoleController } from './role/role.controller.js';
import { RoleService } from './role/role.service.js';
import { RoleAssignmentService } from './role/role-assignment.service.js';
import { RoleRepository } from './role/role.repository.js';
import { TaxRateController } from './taxrate/taxrate.controller.js';
import { TaxRateService } from './taxrate/taxrate.service.js';
import { TaxRateRepository } from './taxrate/taxrate.repository.js';
import {
  StoreInvitationController,
  InvitationController,
  MeInvitationsController,
} from './invitation/invitation.controller.js';
import { InvitationService } from './invitation/invitation.service.js';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { SubscriptionStatusGuard } from '#auth/mobile/guards/subscription-status.guard.js';
import { MobileAuthModule } from '#auth/mobile/mobile-auth.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';

/**
 * Store lifecycle + role/invitation management (Phase 4.5). RbacService,
 * AuditService, UnitOfWork come from global modules; MobileJwtGuard (with its
 * module-scoped deps) from MobileAuthModule.
 * StoreRepository/InvitationRepository come from the global
 * SharedRepositoriesModule (#common/shared-repositories.module.js).
 * EntitlementService (used by StoreService for the create-store limit check)
 * comes from SubscriptionModule — imported, not re-declared locally, so Nest can
 * resolve its own SubscriptionRepository dependency. Nothing outside this module
 * consumes it, so it is not re-exported (that also can't be done by token for an
 * imported provider — see DevicesModule, which uses the same pattern).
 */
@Module({
  imports: [MobileAuthModule, SubscriptionModule, LedgerModule],
  controllers: [
    StoreController,
    RoleController,
    TaxRateController,
    StoreInvitationController,
    InvitationController,
    MeInvitationsController,
  ],
  providers: [
    StoreService,
    RoleService,
    RoleAssignmentService,
    RoleRepository,
    TaxRateService,
    TaxRateRepository,
    InvitationService,
    SubscriptionStatusGuard,
  ],
})
export class StoresModule {}
