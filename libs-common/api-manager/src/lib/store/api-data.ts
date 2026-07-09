import { APIData, APIMethod } from '../api-handler';

/** Create a store — account-level, gated by ownership + max_stores. Auth required. */
export const CREATE_STORE = new APIData('stores', APIMethod.POST);

/** Claim (or refresh) this device's slot on a store. Path: `:storeId`. Auth required. */
export const CLAIM_STORE_ACCESS = new APIData('stores/:storeId/access', APIMethod.POST);

/** Live-computed onboarding checklist for a store. Path: `:storeId`. Auth required. */
export const GET_STORE_SETUP_STATUS = new APIData('stores/:storeId/setup-status', APIMethod.GET);
