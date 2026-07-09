import { Module } from '@nestjs/common';
import { StoreController } from './store/store.controller.js';
import { StoreService } from './store/store.service.js';
import { RoleController } from './role/role.controller.js';
import { RoleService } from './role/role.service.js';
import { RoleRepository } from './role/role.repository.js';
import {
  StoreInvitationController,
  InvitationController,
  MeInvitationsController,
} from './invitation/invitation.controller.js';
import { InvitationService } from './invitation/invitation.service.js';
import { EntitlementService } from '../subscription/entitlement.service.js';
import { SubscriptionStatusGuard } from '#auth/mobile/guards/subscription-status.guard.js';
import { MobileAuthModule } from '#auth/mobile/mobile-auth.module.js';

/**
 * Store lifecycle + role/invitation management (Phase 4.5). RbacService,
 * AuditService, UnitOfWork come from global modules; MobileJwtGuard (with its
 * module-scoped deps) from MobileAuthModule.
 * StoreRepository/InvitationRepository come from the global
 * SharedRepositoriesModule (#common/shared-repositories.module.js).
 */
@Module({
  imports: [MobileAuthModule],
  controllers: [
    StoreController,
    RoleController,
    StoreInvitationController,
    InvitationController,
    MeInvitationsController,
  ],
  providers: [
    StoreService,
    RoleService,
    RoleRepository,
    InvitationService,
    EntitlementService,
    SubscriptionStatusGuard,
  ],
  exports: [EntitlementService],
})
export class StoresModule {}
