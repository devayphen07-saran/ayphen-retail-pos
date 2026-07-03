import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { parse } from '#common/validation/parse.js';
import { MobileJwtGuard } from '#auth/mobile/guards/mobile-jwt.guard.js';
import { TenantGuard } from '#common/rbac/guards/tenant.guard.js';
import { PermissionsGuard } from '#common/rbac/guards/permissions.guard.js';
import { SubscriptionStatusGuard } from '#auth/mobile/guards/subscription-status.guard.js';
import {
  StoreContext,
  RequirePermissions,
  CurrentUser,
} from '#common/rbac/decorators/rbac.decorators.js';
import type { MobilePrincipal } from '#auth/mobile/types/mobile-principal.js';
import type { ResolvedStoreContext } from '#common/rbac/resolved-store-context.js';
import { LocationService } from './location.service.js';
import { UserLocationService } from './user-location.service.js';
import { LocationMapper, type LocationResponse } from './location.mapper.js';
import {
  CreateLocationDtoSchema,
  UpdateLocationDtoSchema,
  AssignLocationUsersDtoSchema,
} from './dto/location.dto.js';

/**
 * Store location management (adoption §8.2). Guard chain: auth → tenant (resolves
 * store + accountId) → permissions (Location entity) → subscription write-gate.
 */
@Controller('stores/:storeId/locations')
@UseGuards(MobileJwtGuard, TenantGuard, PermissionsGuard, SubscriptionStatusGuard)
@StoreContext('param.storeId')
export class LocationController {
  constructor(
    private readonly locations: LocationService,
    private readonly userLocations: UserLocationService,
  ) {}

  @Get()
  @RequirePermissions({ entity: 'Location', action: 'view' })
  async list(@Param('storeId') storeId: string): Promise<LocationResponse[]> {
    return LocationMapper.toList(await this.locations.listLocations(storeId));
  }

  @Post()
  @RequirePermissions({ entity: 'Location', action: 'create' })
  async create(
    @Param('storeId') storeId: string,
    @CurrentUser() user: MobilePrincipal,
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<{ id: string; name: string }> {
    const dto = parse(body, CreateLocationDtoSchema);
    const ctx = (req as Request & { context?: ResolvedStoreContext }).context!;
    return this.locations.createLocation(storeId, ctx.accountId, user.userId, {
      name: dto.name,
      isDefault: dto.is_default,
    });
  }

  @Patch(':locationId')
  @HttpCode(204)
  @RequirePermissions({ entity: 'Location', action: 'edit' })
  async update(
    @Param('storeId') storeId: string,
    @Param('locationId') locationId: string,
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<void> {
    const dto = parse(body, UpdateLocationDtoSchema);
    await this.locations.updateLocation(storeId, user.userId, locationId, {
      name: dto.name,
      enable: dto.enable,
    });
  }

  @Patch(':locationId/default')
  @HttpCode(204)
  @RequirePermissions({ entity: 'Location', action: 'edit' })
  async setDefault(
    @Param('storeId') storeId: string,
    @Param('locationId') locationId: string,
    @CurrentUser() user: MobilePrincipal,
  ): Promise<void> {
    await this.locations.setDefault(storeId, user.userId, locationId);
  }

  @Delete(':locationId')
  @HttpCode(204)
  @RequirePermissions({ entity: 'Location', action: 'delete' })
  async remove(
    @Param('storeId') storeId: string,
    @Param('locationId') locationId: string,
    @CurrentUser() user: MobilePrincipal,
  ): Promise<void> {
    await this.locations.deleteLocation(storeId, user.userId, locationId);
  }

  // ─── User ↔ location assignment (adoption §8.1) ─────────────────────────────

  @Get(':locationId/users')
  @RequirePermissions({ entity: 'UserRoleMapping', action: 'view' })
  async listUsers(
    @Param('storeId') storeId: string,
    @Param('locationId') locationId: string,
  ) {
    const members = await this.userLocations.listMembers(storeId, locationId);
    return members.map((m) => ({
      user_id: m.userId,
      user_name: m.userName,
      assigned_at: m.assignedAt.toISOString(),
    }));
  }

  @Post(':locationId/users')
  @HttpCode(204)
  @RequirePermissions({ entity: 'UserRoleMapping', action: 'create' })
  async assignUsers(
    @Param('storeId') storeId: string,
    @Param('locationId') locationId: string,
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<void> {
    const dto = parse(body, AssignLocationUsersDtoSchema);
    await this.userLocations.assignUsers(storeId, user.userId, locationId, dto.user_ids);
  }

  @Delete(':locationId/users/:userId')
  @HttpCode(204)
  @RequirePermissions({ entity: 'UserRoleMapping', action: 'delete' })
  async revokeUser(
    @Param('storeId') storeId: string,
    @Param('locationId') locationId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: MobilePrincipal,
  ): Promise<void> {
    await this.userLocations.revokeUser(storeId, user.userId, locationId, targetUserId);
  }
}
