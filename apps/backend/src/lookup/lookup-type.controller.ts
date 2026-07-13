import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { parse } from '#common/validation/parse.js';
import { MobileJwtGuard } from '#auth/mobile/guards/mobile-jwt.guard.js';
import { SuperAdminGuard } from '#common/rbac/guards/super-admin.guard.js';
import { StoreContext, CurrentUser } from '#common/rbac/decorators/rbac.decorators.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import { LookupService } from './lookup.service.js';
import { LookupTypeMapper, type LookupTypeResponse } from './lookup-type.mapper.js';
import { CreateLookupTypeDtoSchema } from './dto/lookup.dto.js';
import { LookupRequestMapper } from './lookup.request-mapper.js';

/** Lookup category management (lookup-entity-prd.md §7) — platform-admin only. */
@Controller('lookup/types')
@UseGuards(MobileJwtGuard, SuperAdminGuard)
@StoreContext('none')
export class LookupTypeController {
  constructor(private readonly lookup: LookupService) {}

  @Get()
  async list(): Promise<LookupTypeResponse[]> {
    const rows = await this.lookup.listTypes();
    return LookupTypeMapper.toList(rows);
  }

  @Post()
  async create(
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<LookupTypeResponse> {
    const dto = parse(body, CreateLookupTypeDtoSchema);
    const row = await this.lookup.createType(
      user.userId,
      LookupRequestMapper.toCreateTypeCommand(dto),
    );
    return LookupTypeMapper.toResponse(row);
  }
}
