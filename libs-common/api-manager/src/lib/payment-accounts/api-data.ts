import { APIData, APIMethod } from '../api-handler';

/**
 * Payment-account management (online). Routes mirror
 * apps/backend/src/payments/payment-account.controller.ts. The offline POS
 * checkout reads accounts from the local sync cache instead of these endpoints.
 */

export const GET_PAYMENT_ACCOUNTS = new APIData('stores/:storeId/payment-accounts', APIMethod.GET);

export const CREATE_PAYMENT_ACCOUNT = new APIData(
  'stores/:storeId/payment-accounts',
  APIMethod.POST,
);

export const UPDATE_PAYMENT_ACCOUNT = new APIData(
  'stores/:storeId/payment-accounts/:guuid',
  APIMethod.PATCH,
);

export const DELETE_PAYMENT_ACCOUNT = new APIData(
  'stores/:storeId/payment-accounts/:guuid',
  APIMethod.DELETE,
);
