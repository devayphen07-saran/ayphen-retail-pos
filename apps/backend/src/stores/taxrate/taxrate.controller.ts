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
  OnlineOnly,
  CurrentUser,
} from '#common/rbac/decorators/rbac.decorators.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import { TaxRateService } from './taxrate.service.js';
import {
  CreateTaxRateDtoSchema,
  UpdateTaxRateDtoSchema,
} from './dto/taxrate.dto.js';
import { TaxRateResponseMapper } from './taxrate.mapper.js';
import type { TaxRateResponse } from './dto/taxrate.response.js';

/**
 * Tax-rate management (online-only, server-authoritative). Reads reach devices
 * via the sync pull; these endpoints own the writes. Guard chain mirrors
 * RoleController: auth → tenant (resolves + authorizes the store) → permissions
 * → subscription. Writes are additionally `@OnlineOnly` — a queued offline
 * replay is rejected, so a tax rate can never be authored off a divergent
 * offline copy.
 */
@Controller('stores/:storeId/tax-rates')
@UseGuards(MobileJwtGuard, TenantGuard, PermissionsGuard, SubscriptionStatusGuard)
@StoreContext('param.storeId')
export class TaxRateController {
  constructor(private readonly taxRates: TaxRateService) {}

  @Get()
  @RequirePermissions({ entity: 'TaxRate', action: 'view' })
  async list(
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ): Promise<TaxRateResponse[]> {
    const rows = await this.taxRates.listRates(storeId);
    return TaxRateResponseMapper.toListResponse(rows);
  }

  @Get(':taxRateId')
  @RequirePermissions({ entity: 'TaxRate', action: 'view' })
  async get(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('taxRateId', ParseUUIDPipe) taxRateId: string,
  ): Promise<TaxRateResponse> {
    const row = await this.taxRates.getRate(storeId, taxRateId);
    return TaxRateResponseMapper.toResponse(row);
  }

  @Post()
  @OnlineOnly()
  @RequirePermissions({ entity: 'TaxRate', action: 'create' })
  async create(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<TaxRateResponse> {
    const dto = parse(body, CreateTaxRateDtoSchema);
    const row = await this.taxRates.create(storeId, user.userId, {
      name:        dto.name,
      ratePercent: dto.rate_percent,
      isInclusive: dto.is_inclusive,
    });
    return TaxRateResponseMapper.toResponse(row);
  }

  @Patch(':taxRateId')
  @OnlineOnly()
  @RequirePermissions({ entity: 'TaxRate', action: 'edit' })
  async update(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('taxRateId', ParseUUIDPipe) taxRateId: string,
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<TaxRateResponse> {
    const dto = parse(body, UpdateTaxRateDtoSchema);
    const row = await this.taxRates.update(storeId, user.userId, taxRateId, {
      name:               dto.name,
      ratePercent:        dto.rate_percent,
      isInclusive:        dto.is_inclusive,
      expectedRowVersion: dto.expected_row_version,
    });
    return TaxRateResponseMapper.toResponse(row);
  }

  @Delete(':taxRateId')
  @OnlineOnly()
  @HttpCode(204)
  @RequirePermissions({ entity: 'TaxRate', action: 'delete' })
  async deactivate(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('taxRateId', ParseUUIDPipe) taxRateId: string,
    @CurrentUser() user: MobilePrincipal,
  ): Promise<void> {
    await this.taxRates.deactivate(storeId, user.userId, taxRateId);
  }
}
