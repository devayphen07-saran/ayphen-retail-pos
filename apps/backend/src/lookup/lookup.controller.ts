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
import { LookupService } from './lookup.service.js';
import {
  LookupValueMapper,
  type LookupValueResponse,
} from './lookup-value.mapper.js';
import {
  CreateLookupValueDtoSchema,
  UpdateLookupValueDtoSchema,
} from './dto/lookup.dto.js';
import { LookupRequestMapper } from './lookup.request-mapper.js';

/**
 * Lookup values API (lookup-entity-prd.md §7). Reads are any authenticated
 * store member (Lookup.view — granted to every default custom role); writes
 * require Lookup.create/edit/delete, which only STORE_OWNER gets by default
 * (BR-2) — a custom role needs an explicit grant, same as Role/Invitation.
 */
@Controller('stores/:storeId/lookup')
@UseGuards(
  MobileJwtGuard,
  TenantGuard,
  PermissionsGuard,
  SubscriptionStatusGuard,
)
@StoreContext('param.storeId')
export class LookupController {
  constructor(private readonly lookup: LookupService) {}

  @Get(':typeCode/values')
  @RequirePermissions({ entity: 'Lookup', action: 'view' })
  async listValues(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('typeCode') typeCode: string,
  ): Promise<LookupValueResponse[]> {
    const rows = await this.lookup.listValues(typeCode, storeId);
    return LookupValueMapper.toList(rows);
  }

  @Post(':typeCode/values')
  @RequirePermissions({ entity: 'Lookup', action: 'create' })
  async addValue(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('typeCode') typeCode: string,
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<LookupValueResponse> {
    const dto = parse(body, CreateLookupValueDtoSchema);
    const row = await this.lookup.addValue(
      typeCode,
      storeId,
      user.userId,
      LookupRequestMapper.toCreateValueCommand(dto),
    );
    return LookupValueMapper.toResponse(row);
  }

  @Patch('values/:lookupValueId')
  @RequirePermissions({ entity: 'Lookup', action: 'edit' })
  async updateValue(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('lookupValueId', ParseUUIDPipe) lookupValueId: string,
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<LookupValueResponse> {
    const dto = parse(body, UpdateLookupValueDtoSchema);
    const row = await this.lookup.updateValue(
      lookupValueId,
      storeId,
      user.userId,
      LookupRequestMapper.toUpdateValueCommand(dto),
    );
    return LookupValueMapper.toResponse(row);
  }

  @Delete('values/:lookupValueId')
  @HttpCode(204)
  @RequirePermissions({ entity: 'Lookup', action: 'delete' })
  async removeValue(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('lookupValueId', ParseUUIDPipe) lookupValueId: string,
    @CurrentUser() user: MobilePrincipal,
  ): Promise<void> {
    await this.lookup.softDeleteValue(lookupValueId, storeId, user.userId);
  }
}
