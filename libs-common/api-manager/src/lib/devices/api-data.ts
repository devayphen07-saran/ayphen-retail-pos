import { APIData, APIMethod } from '../api-handler';

/**
 * Device management (device-management.md). Two scopes: user-level ("My
 * Devices", every store) and store-level ("Manage Devices", one store).
 */

/** All devices registered to the current user, across every store (F7). */
export const GET_MY_DEVICES = new APIData('devices/my', APIMethod.GET);

/** Block a stolen/lost device — kills all sessions and store access globally (F8). */
export const BLOCK_DEVICE = new APIData('devices/:deviceId/block', APIMethod.PATCH);

/** Unblock a recovered device. Sessions/slots stay revoked — device is "fresh" (F9). */
export const UNBLOCK_DEVICE = new APIData('devices/:deviceId/unblock', APIMethod.PATCH);

/** Devices that have accessed a store (owner/manager view, F4). */
export const GET_STORE_DEVICES = new APIData('stores/:storeId/devices', APIMethod.GET);

/** Remove a device from a store (owner only, F5). Cannot remove your own current device. */
export const REVOKE_DEVICE = new APIData(
  'stores/:storeId/devices/:deviceId',
  APIMethod.DELETE,
);
