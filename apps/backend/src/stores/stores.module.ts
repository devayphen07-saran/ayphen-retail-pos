import { Module } from '@nestjs/common';
import { StoreController } from './store.controller.js';
import { StoreService } from './store.service.js';
import { StoreRepository } from './store.repository.js';
import { RoleController } from './role.controller.js';
import { RoleService } from './role.service.js';
import { RoleRepository } from './role.repository.js';
import {
  StoreInvitationController,
  InvitationController,
} from './invitation.controller.js';
import { InvitationService } from './invitation.service.js';
import { InvitationRepository } from './invitation.repository.js';
import { EntitlementService } from '../subscription/entitlement.service.js';
import { SubscriptionStatusGuard } from '../auth/mobile/guards/subscription-status.guard.js';
import { MobileAuthModule } from '../auth/mobile/mobile-auth.module.js';

/**
 * Store lifecycle + role/invitation management (Phase 4.5). RbacService,
 * AuditService, UnitOfWork come from global modules; MobileJwtGuard (with its
 * module-scoped deps) from MobileAuthModule.
 */
@Module({
  imports: [MobileAuthModule],
  controllers: [
    StoreController,
    RoleController,
    StoreInvitationController,
    InvitationController,
  ],
  providers: [
    StoreService,
    StoreRepository,
    RoleService,
    RoleRepository,
    InvitationService,
    InvitationRepository,
    EntitlementService,
    SubscriptionStatusGuard,
  ],
  exports: [EntitlementService],
})
export class StoresModule {}
