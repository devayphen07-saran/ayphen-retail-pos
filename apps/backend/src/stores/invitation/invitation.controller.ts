import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { parse } from '#common/validation/parse.js';
import { getRequestIp } from '#common/request-ip.js';
import { MobileJwtGuard } from '#auth/mobile/guards/mobile-jwt.guard.js';
import { TenantGuard } from '#common/rbac/guards/tenant.guard.js';
import { PermissionsGuard } from '#common/rbac/guards/permissions.guard.js';
import { SubscriptionStatusGuard } from '#auth/mobile/guards/subscription-status.guard.js';
import {
  StoreContext,
  RequirePermissions,
  CurrentUser,
  CurrentStoreContext,
} from '#common/rbac/decorators/rbac.decorators.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import type { ResolvedStoreContext } from '#common/rbac/resolved-store-context.js';
import { InvitationService } from './invitation.service.js';
import { InvitationMapper } from './invitation.mapper.js';
import type {
  MyInvitationResponse,
  AcceptInvitationResponse,
  CreatedInvitationResponse,
  InvitationActionResponse,
} from './dto/invitation.response.js';
import {
  CreateInvitationDtoSchema,
  AcceptInvitationDtoSchema,
  RejectInvitationDtoSchema,
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
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @CurrentUser() user: MobilePrincipal,
    @CurrentStoreContext() ctx: ResolvedStoreContext,
    @Body() body: unknown,
  ): Promise<CreatedInvitationResponse> {
    const dto = parse(body, CreateInvitationDtoSchema);
    const result = await this.invitations.create(storeId, ctx.accountId, user.userId, {
      roleId:      dto.role_id,
      phone:       dto.phone,
      email:       dto.email,
      locationIds: dto.location_ids,
    });
    return InvitationMapper.toCreatedResponse(result);
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
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<AcceptInvitationResponse> {
    const dto = parse(body, AcceptInvitationDtoSchema);
    const result = await this.invitations.accept(dto.token, user.userId, getRequestIp(req));
    return InvitationMapper.toAcceptInvitationResponse(result);
  }

  /**
   * Accept in-app from GET /me/invitations — by id, no token echoed. Authorized
   * because the invite is addressed to the caller's own verified contact.
   */
  @Post(':id/accept')
  async acceptById(
    @Param('id', ParseUUIDPipe) invitationId: string,
    @CurrentUser() user: MobilePrincipal,
    @Req() req: Request,
  ): Promise<AcceptInvitationResponse> {
    const result = await this.invitations.acceptById(invitationId, user.userId, getRequestIp(req));
    return InvitationMapper.toAcceptInvitationResponse(result);
  }

  @Post('reject')
  async reject(@Req() req: Request, @Body() body: unknown): Promise<InvitationActionResponse> {
    const dto = parse(body, RejectInvitationDtoSchema);
    await this.invitations.reject(dto.token, getRequestIp(req));
    return InvitationMapper.toActionResponse();
  }

  /** Decline in-app from GET /me/invitations — by id, contact-authorized. */
  @Post(':id/reject')
  async rejectById(
    @Param('id', ParseUUIDPipe) invitationId: string,
    @CurrentUser() user: MobilePrincipal,
    @Req() req: Request,
  ): Promise<InvitationActionResponse> {
    await this.invitations.rejectById(invitationId, user.userId, getRequestIp(req));
    return InvitationMapper.toActionResponse();
  }
}

/** List the authenticated user's own pending invitations (mobile-03 §8D.3/8D.4). */
@Controller('me')
@UseGuards(MobileJwtGuard)
export class MeInvitationsController {
  constructor(private readonly invitations: InvitationService) {}

  @Get('invitations')
  async listMine(@CurrentUser() user: MobilePrincipal): Promise<MyInvitationResponse[]> {
    const rows = await this.invitations.listMyInvitations(user.userId);
    return InvitationMapper.toMyInvitationList(rows);
  }
}
