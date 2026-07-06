import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { parse } from '#common/validation/parse.js';
import { MobileJwtGuard } from '#auth/mobile/guards/mobile-jwt.guard.js';
import { TenantGuard } from '#common/rbac/guards/tenant.guard.js';
import { PermissionsGuard } from '#common/rbac/guards/permissions.guard.js';
import { LocationGuard } from '#common/rbac/guards/location.guard.js';
import { SubscriptionStatusGuard } from '#auth/mobile/guards/subscription-status.guard.js';
import {
  StoreContext,
  LocationContext,
  RequirePermissions,
  CurrentUser,
  CurrentStoreContext,
} from '#common/rbac/decorators/rbac.decorators.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import type { ResolvedStoreContext } from '#common/rbac/resolved-store-context.js';
import { LocationService } from './location.service.js';
import { UserLocationService } from './user-location.service.js';
import { LocationMapper, type LocationResponse, type LocationMemberResponse } from './location.mapper.js';
import {
  CreateLocationDtoSchema,
  UpdateLocationDtoSchema,
  AssignLocationUsersDtoSchema,
} from './dto/location.dto.js';

/**
 * Store location management (adoption §8.2). Guard chain: auth → tenant (resolves
 * store + accountId) → location (dual-gate: WHAT via permissions, WHERE via
 * assignment) → permissions (Location entity) → subscription write-gate.
 */
@Controller('stores/:storeId/locations')
@UseGuards(MobileJwtGuard, TenantGuard, PermissionsGuard, LocationGuard, SubscriptionStatusGuard)
@StoreContext('param.storeId')
export class LocationController {
  constructor(
    private readonly locations: LocationService,
    private readonly userLocations: UserLocationService,
  ) {}

  @Get()
  @RequirePermissions({ entity: 'Location', action: 'view' })
  async list(@Param('storeId', ParseUUIDPipe) storeId: string): Promise<LocationResponse[]> {
    return LocationMapper.toList(await this.locations.listLocations(storeId));
  }

  @Post()
  @RequirePermissions({ entity: 'Location', action: 'create' })
  async create(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @CurrentUser() user: MobilePrincipal,
    @CurrentStoreContext() ctx: ResolvedStoreContext,
    @Body() body: unknown,
  ): Promise<LocationResponse> {
    const dto = parse(body, CreateLocationDtoSchema);
    return LocationMapper.toResponse(
      await this.locations.createLocation(storeId, ctx.accountId, user.userId, {
        name: dto.name,
        isDefault: dto.is_default,
      }),
    );
  }

  @Patch(':locationId')
  @HttpCode(204)
  @LocationContext('param.locationId')
  @RequirePermissions({ entity: 'Location', action: 'edit' })
  async update(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('locationId', ParseUUIDPipe) locationId: string,
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
  @LocationContext('param.locationId')
  @RequirePermissions({ entity: 'Location', action: 'edit' })
  async setDefault(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @CurrentUser() user: MobilePrincipal,
  ): Promise<void> {
    await this.locations.setDefault(storeId, user.userId, locationId);
  }

  @Delete(':locationId')
  @HttpCode(204)
  @LocationContext('param.locationId')
  @RequirePermissions({ entity: 'Location', action: 'delete' })
  async remove(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @CurrentUser() user: MobilePrincipal,
  ): Promise<void> {
    await this.locations.deleteLocation(storeId, user.userId, locationId);
  }

  // ─── User ↔ location assignment (adoption §8.1) ─────────────────────────────
  // Every route below acts on a specific location's membership, so each also
  // carries @LocationContext: WHAT (the UserRoleMapping permission) and WHERE
  // (this location) are both required — an owner is implicitly assigned to
  // every location (LocationGuard's bypass); anyone else must be assigned to
  // *this* location, not just hold the permission somewhere in the store.

  @Get(':locationId/users')
  @LocationContext('param.locationId')
  @RequirePermissions({ entity: 'UserRoleMapping', action: 'view' })
  async listUsers(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('locationId', ParseUUIDPipe) locationId: string,
  ): Promise<LocationMemberResponse[]> {
    const members = await this.userLocations.listMembers(storeId, locationId);
    return LocationMapper.toMemberList(members);
  }

  @Post(':locationId/users')
  @HttpCode(204)
  @LocationContext('param.locationId')
  @RequirePermissions({ entity: 'UserRoleMapping', action: 'create' })
  async assignUsers(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<void> {
    const dto = parse(body, AssignLocationUsersDtoSchema);
    await this.userLocations.assignUsers(storeId, user.userId, locationId, dto.user_ids);
  }

  @Delete(':locationId/users/:userId')
  @HttpCode(204)
  @LocationContext('param.locationId')
  @RequirePermissions({ entity: 'UserRoleMapping', action: 'delete' })
  async revokeUser(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
    @CurrentUser() user: MobilePrincipal,
  ): Promise<void> {
    await this.userLocations.revokeUser(storeId, user.userId, locationId, targetUserId);
  }
}
