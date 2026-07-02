import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { parse } from '../common/validation/parse.js';
import { MobileJwtGuard } from '../auth/mobile/guards/mobile-jwt.guard.js';
import { TenantGuard } from '../common/rbac/guards/tenant.guard.js';
import { PermissionsGuard } from '../common/rbac/guards/permissions.guard.js';
import { SubscriptionStatusGuard } from '../auth/mobile/guards/subscription-status.guard.js';
import {
  StoreContext,
  RequirePermissions,
  CurrentUser,
} from '../common/rbac/decorators/rbac.decorators.js';
import type { MobilePrincipal } from '../auth/mobile/types/mobile-principal.js';
import type { ResolvedStoreContext } from '../common/rbac/resolved-store-context.js';
import { InvitationService } from './invitation.service.js';
import {
  CreateInvitationDtoSchema,
  AcceptInvitationDtoSchema,
} from './dto/invitation.dto.js';

/** Create an invitation — store-scoped, gated by Invitation.create + max_users. */
@Controller('stores/:storeId/invitations')
@UseGuards(MobileJwtGuard, TenantGuard, PermissionsGuard, SubscriptionStatusGuard)
@StoreContext('param.storeId')
export class StoreInvitationController {
  constructor(private readonly invitations: InvitationService) {}

  @Post()
  @RequirePermissions({ entity: 'Invitation', action: 'create' })
  async create(
    @Param('storeId') storeId: string,
    @CurrentUser() user: MobilePrincipal,
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<{ id: string; token: string }> {
    const dto = parse(body, CreateInvitationDtoSchema);
    const ctx = (req as Request & { context?: ResolvedStoreContext }).context!;
    return this.invitations.create(storeId, ctx.accountId, user.userId, {
      roleId: dto.role_id,
      phone:  dto.phone,
      email:  dto.email,
    });
  }
}

/** Accept an invitation — user-level; the token carries the store, so no @StoreContext. */
@Controller('invitations')
@UseGuards(MobileJwtGuard)
export class InvitationController {
  constructor(private readonly invitations: InvitationService) {}

  @Post('accept')
  async accept(
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<{ storeId: string }> {
    const dto = parse(body, AcceptInvitationDtoSchema);
    return this.invitations.accept(dto.token, user.userId);
  }
}
