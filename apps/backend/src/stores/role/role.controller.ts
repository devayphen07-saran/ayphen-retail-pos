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
import { SubscriptionStatusGuard } from '#auth/mobile/guards/subscription-status.guard.js';
import {
  StoreContext,
  RequirePermissions,
  CurrentUser,
} from '#common/rbac/decorators/rbac.decorators.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import { RoleService } from './role.service.js';
import {
  CreateRoleDtoSchema,
  UpdatePermissionsDtoSchema,
  AssignRoleDtoSchema,
} from './dto/role.dto.js';
import { RoleResponseMapper } from './role.mapper.js';
import type { RoleResponse, RoleDetailResponse, CreatedRoleResponse } from './dto/role.response.js';

/**
 * Role management (rbac.md §21). Full guard chain: auth → tenant (resolves +
 * authorizes the store) → permissions (CRUD gate). @StoreContext applies to the
 * whole class; each handler declares its @RequirePermissions.
 */
@Controller('stores/:storeId/roles')
@UseGuards(MobileJwtGuard, TenantGuard, PermissionsGuard, SubscriptionStatusGuard)
@StoreContext('param.storeId')
export class RoleController {
  constructor(private readonly roles: RoleService) {}

  @Get()
  @RequirePermissions({ entity: 'Role', action: 'view' })
  async list(@Param('storeId') storeId: string): Promise<RoleResponse[]> {
    const roles = await this.roles.listRoles(storeId);
    return RoleResponseMapper.toListResponse(roles);
  }

  @Get(':roleId')
  @RequirePermissions({ entity: 'Role', action: 'view' })
  async get(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
  ): Promise<RoleDetailResponse> {
    const { role, grants } = await this.roles.getRole(storeId, roleId);
    return RoleResponseMapper.toDetailResponse(role, grants);
  }

  @Post()
  @RequirePermissions({ entity: 'Role', action: 'create' })
  async create(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<CreatedRoleResponse> {
    const dto = parse(body, CreateRoleDtoSchema);
    const role = await this.roles.createRole(storeId, user.userId, dto.name, dto.description ?? null);
    return RoleResponseMapper.toCreatedResponse(role);
  }

  @Patch(':roleId/permissions')
  @HttpCode(204)
  @RequirePermissions({ entity: 'Role', action: 'edit' })
  async updatePermissions(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<void> {
    const dto = parse(body, UpdatePermissionsDtoSchema);
    await this.roles.updatePermissions(storeId, user.userId, roleId, dto.permissions);
  }

  @Delete(':roleId')
  @HttpCode(204)
  @RequirePermissions({ entity: 'Role', action: 'delete' })
  async remove(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @CurrentUser() user: MobilePrincipal,
  ): Promise<void> {
    await this.roles.deleteRole(storeId, user.userId, roleId);
  }

  @Post(':roleId/assign')
  @HttpCode(204)
  @RequirePermissions({ entity: 'UserRoleMapping', action: 'create' })
  async assign(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<void> {
    const dto = parse(body, AssignRoleDtoSchema);
    await this.roles.assignRole(storeId, user.userId, roleId, dto.user_id);
  }

  @Delete(':roleId/members/:userId')
  @HttpCode(204)
  @RequirePermissions({ entity: 'UserRoleMapping', action: 'delete' })
  async revoke(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
    @CurrentUser() user: MobilePrincipal,
  ): Promise<void> {
    await this.roles.revokeRole(storeId, user.userId, roleId, targetUserId);
  }
}
