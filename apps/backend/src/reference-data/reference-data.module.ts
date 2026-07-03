import { Module } from '@nestjs/common';
import { ReferenceDataController } from './reference-data.controller.js';
import { CountryRepository } from './country.repository.js';
import { CurrencyRepository } from './currency.repository.js';
import { MobileAuthModule } from '#auth/mobile/mobile-auth.module.js';

@Module({
  imports: [MobileAuthModule],
  controllers: [ReferenceDataController],
  providers: [CountryRepository, CurrencyRepository],
})
export class ReferenceDataModule {}