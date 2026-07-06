import { APIData, APIMethod } from '../api-handler';

/**
 * Store locations (rbac.md §26.1, adoption §8.2). Every route lives under
 * `stores/:storeId/locations` — mirrors `apps/backend/src/locations/location.controller.ts`
 * exactly. Store-scoped: `storeId` is always a path param, never inferred server-side.
 */

/** Active locations in a store. */
export const GET_LOCATIONS = new APIData('stores/:storeId/locations', APIMethod.GET);

/** Create a location. Gated by max_locations_per_store + name uniqueness (server-side). */
export const CREATE_LOCATION = new APIData('stores/:storeId/locations', APIMethod.POST);

/** Rename and/or enable/disable a location. Head Office and the default location can't be disabled. */
export const UPDATE_LOCATION = new APIData(
  'stores/:storeId/locations/:locationId',
  APIMethod.PATCH,
);

/** Make this location the store's default (clears the previous one). */
export const SET_DEFAULT_LOCATION = new APIData(
  'stores/:storeId/locations/:locationId/default',
  APIMethod.PATCH,
);

/** Soft-delete a location. Head Office can't be deleted; the sole default can't either. */
export const DELETE_LOCATION = new APIData(
  'stores/:storeId/locations/:locationId',
  APIMethod.DELETE,
);