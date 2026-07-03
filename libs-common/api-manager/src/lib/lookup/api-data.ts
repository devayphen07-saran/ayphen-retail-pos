import { APIData, APIMethod } from '../api-handler';

/**
 * Global (no store context) lookup values for a type — e.g. BUSINESS_CATEGORY,
 * GST_REGISTRATION_TYPE. For dropdowns that must work before a store exists
 * (create-store wizard). Store-custom values are never returned here — those
 * live behind the store-scoped lookup endpoints instead. Path: `:typeCode`.
 * Auth required.
 */
export const GET_GLOBAL_LOOKUPS = new APIData('lookup/:typeCode/values', APIMethod.GET);

/** Indian states / union territories — `code` is the 2-digit GST state code. Auth required. */
export const GET_STATES = new APIData('lookup/STATE/values', APIMethod.GET);

/** All active currencies (ISO 4217). Auth required. */
export const GET_CURRENCIES = new APIData('currencies', APIMethod.GET);

/** All active countries (ISO 3166-1 alpha-2). Auth required. */
export const GET_COUNTRIES = new APIData('countries', APIMethod.GET);
