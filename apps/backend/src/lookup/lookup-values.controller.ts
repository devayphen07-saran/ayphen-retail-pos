import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { MobileJwtGuard } from '#auth/mobile/guards/mobile-jwt.guard.js';
import { StoreContext } from '#common/rbac/decorators/rbac.decorators.js';
import { LookupService } from './lookup.service.js';
import { LookupValueMapper, type LookupValueResponse } from './lookup-value.mapper.js';

/**
 * Global-only lookup values, no store context required (lookup-entity-prd.md
 * §7 follow-up) — for dropdowns that must work before a store exists, e.g.
 * BUSINESS_CATEGORY / GST_REGISTRATION_TYPE / STATE in the create-store
 * wizard. Store-scoped custom values live behind `lookup.controller.ts`
 * instead (`stores/:storeId/lookup/...`), which this deliberately does not
 * expose — a value stored under a specific store is never returned here.
 */
@Controller('lookup')
@UseGuards(MobileJwtGuard)
@StoreContext('none')
export class LookupValuesController {
  constructor(private readonly lookup: LookupService) {}

  @Get(':typeCode/values')
  async listGlobalValues(@Param('typeCode') typeCode: string): Promise<LookupValueResponse[]> {
    const rows = await this.lookup.listGlobalValues(typeCode);
    return LookupValueMapper.toList(rows);
  }
}