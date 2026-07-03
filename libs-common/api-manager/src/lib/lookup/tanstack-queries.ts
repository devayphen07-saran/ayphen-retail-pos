import { useQuery, type QueryClient } from '@tanstack/react-query';
import { GET_GLOBAL_LOOKUPS, GET_STATES, GET_CURRENCIES, GET_COUNTRIES } from './api-data';
import type { LookupValueResponse, CurrencyResponse, CountryResponse } from './types';

export const lookupKeys = {
  all: ['lookup'] as const,
  global: (typeCode: string) => [...lookupKeys.all, 'global', typeCode] as const,
  states: () => [...lookupKeys.all, 'states'] as const,
  currencies: () => [...lookupKeys.all, 'currencies'] as const,
  countries: () => [...lookupKeys.all, 'countries'] as const,
};

/** Global values for any lookup type (e.g. BUSINESS_CATEGORY, GST_REGISTRATION_TYPE). */
export const useGlobalLookupQuery = (typeCode: string, options?: { enabled?: boolean }) =>
  useQuery({
    ...GET_GLOBAL_LOOKUPS.queryOptions<LookupValueResponse[]>({ pathParam: { typeCode } }),
    queryKey: lookupKeys.global(typeCode),
    enabled: options?.enabled ?? !!typeCode,
  });

export const useStatesQuery = (options?: { enabled?: boolean }) =>
  useQuery({
    ...GET_STATES.queryOptions<LookupValueResponse[]>(),
    queryKey: lookupKeys.states(),
    enabled: options?.enabled,
  });

export const useCurrenciesQuery = (options?: { enabled?: boolean }) =>
  useQuery({
    ...GET_CURRENCIES.queryOptions<CurrencyResponse[]>(),
    queryKey: lookupKeys.currencies(),
    enabled: options?.enabled,
  });

export const useCountriesQuery = (options?: { enabled?: boolean }) =>
  useQuery({
    ...GET_COUNTRIES.queryOptions<CountryResponse[]>(),
    queryKey: lookupKeys.countries(),
    enabled: options?.enabled,
  });

// ── Prefetch helpers ─────────────────────────────────────────────────────────
// Same query keys as the hooks above, so a screen can warm the cache ahead of
// time (e.g. the onboarding hub prefetching the create-store wizard's
// dropdown data) and the hook that eventually mounts hits cache, not network.

export const prefetchGlobalLookup = (queryClient: QueryClient, typeCode: string) =>
  queryClient.prefetchQuery({
    ...GET_GLOBAL_LOOKUPS.queryOptions<LookupValueResponse[]>({ pathParam: { typeCode } }),
    queryKey: lookupKeys.global(typeCode),
  });

export const prefetchStates = (queryClient: QueryClient) =>
  queryClient.prefetchQuery({
    ...GET_STATES.queryOptions<LookupValueResponse[]>(),
    queryKey: lookupKeys.states(),
  });

export const prefetchCurrencies = (queryClient: QueryClient) =>
  queryClient.prefetchQuery({
    ...GET_CURRENCIES.queryOptions<CurrencyResponse[]>(),
    queryKey: lookupKeys.currencies(),
  });