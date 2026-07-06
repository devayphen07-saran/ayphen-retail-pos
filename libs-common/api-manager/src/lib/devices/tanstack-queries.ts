import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GET_MY_DEVICES,
  BLOCK_DEVICE,
  UNBLOCK_DEVICE,
  GET_STORE_DEVICES,
  REVOKE_DEVICE,
} from './api-data';
import type { MyDeviceResponse, StoreDeviceResponse } from './types';

export const deviceKeys = {
  all:       ['devices'] as const,
  mine:      () => [...deviceKeys.all, 'my'] as const,
  storeList: (storeId: string) => [...deviceKeys.all, 'store', storeId] as const,
};

/** All devices registered to the current user, across every store (F7). */
export const useMyDevicesQuery = () =>
  useQuery({
    ...GET_MY_DEVICES.queryOptions<MyDeviceResponse[]>(),
    queryKey: deviceKeys.mine(),
  });

/** Block a stolen/lost device — global kill (F8). Caller passes `{ pathParam: { deviceId } }`. */
export const useBlockDeviceMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    BLOCK_DEVICE.mutationOptions<void, undefined>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: deviceKeys.mine() });
      },
    }),
  );
};

/** Unblock a recovered device (F9). Caller passes `{ pathParam: { deviceId } }`. */
export const useUnblockDeviceMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    UNBLOCK_DEVICE.mutationOptions<void, undefined>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: deviceKeys.mine() });
      },
    }),
  );
};

/** Devices that have accessed a store (owner/manager view, F4). */
export const useStoreDevicesQuery = (storeId: string, options?: { enabled?: boolean }) =>
  useQuery({
    ...GET_STORE_DEVICES.queryOptions<StoreDeviceResponse[]>({ pathParam: { storeId } }),
    queryKey: deviceKeys.storeList(storeId),
    enabled: options?.enabled ?? !!storeId,
  });

/** Remove a device from a store (owner only, F5). Caller passes `{ pathParam: { storeId, deviceId } }`. */
export const useRevokeDeviceMutation = (storeId: string) => {
  const queryClient = useQueryClient();
  return useMutation(
    REVOKE_DEVICE.mutationOptions<void, undefined>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: deviceKeys.storeList(storeId) });
      },
    }),
  );
};
