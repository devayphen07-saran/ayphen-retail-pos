import { Injectable } from '@nestjs/common';
import { CountryRepository, type CountryRow } from './country.repository.js';
import { CurrencyRepository, type CurrencyRow } from './currency.repository.js';

/** Static master-data reads (countries, currencies) — no business rules, just repo delegation. */
@Injectable()
export class ReferenceDataService {
  constructor(
    private readonly countries: CountryRepository,
    private readonly currencies: CurrencyRepository,
  ) {}

  listCountries(): Promise<CountryRow[]> {
    return this.countries.listActive();
  }

  listCurrencies(): Promise<CurrencyRow[]> {
    return this.currencies.listActive();
  }
}
