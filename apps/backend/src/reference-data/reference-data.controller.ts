import { Controller, Get, UseGuards } from '@nestjs/common';
import { MobileJwtGuard } from '#auth/mobile/guards/mobile-jwt.guard.js';
import { StoreContext } from '#common/rbac/decorators/rbac.decorators.js';
import { ReferenceDataService } from './reference-data.service.js';
import {
  CountryMapper,
  CurrencyMapper,
  type CountryResponse,
  type CurrencyResponse,
} from './reference-data.mapper.js';

/**
 * Static master data (countries, currencies) — account-level, not store-
 * scoped, read-only. Populates dropdowns that need to work before any store
 * exists (e.g. the create-store wizard).
 */
@Controller()
@UseGuards(MobileJwtGuard)
@StoreContext('none')
export class ReferenceDataController {
  constructor(private readonly referenceData: ReferenceDataService) {}

  @Get('countries')
  async listCountries(): Promise<CountryResponse[]> {
    const rows = await this.referenceData.listCountries();
    return CountryMapper.toList(rows);
  }

  @Get('currencies')
  async listCurrencies(): Promise<CurrencyResponse[]> {
    const rows = await this.referenceData.listCurrencies();
    return CurrencyMapper.toList(rows);
  }
}