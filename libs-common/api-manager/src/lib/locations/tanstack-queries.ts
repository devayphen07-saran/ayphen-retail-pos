import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GET_LOCATIONS,
  CREATE_LOCATION,
  UPDATE_LOCATION,
  SET_DEFAULT_LOCATION,
  DELETE_LOCATION,
} from './api-data';
import type { LocationResponse, CreateLocationRequest, UpdateLocationRequest } from './types';

export const locationKeys = {
  all:  ['locations'] as const,
  list: (storeId: string) => [...locationKeys.all, storeId] as const,
};

/** Active locations in a store. Callers still pass `pathParam: { storeId }`
 *  on the mutations below (api-handler convention) — storeId is taken here
 *  only to key the cache and drive the query itself. */
export const useLocationsQuery = (storeId: string, options?: { enabled?: boolean }) =>
  useQuery({
    ...GET_LOCATIONS.queryOptions<LocationResponse[]>({ pathParam: { storeId } }),
    queryKey: locationKeys.list(storeId),
    enabled: options?.enabled ?? !!storeId,
  });

/** Create a location. Caller passes `{ pathParam: { storeId }, bodyParam }`. */
export const useCreateLocationMutation = (storeId: string) => {
  const queryClient = useQueryClient();
  return useMutation(
    CREATE_LOCATION.mutationOptions<LocationResponse, CreateLocationRequest>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: locationKeys.list(storeId) });
      },
    }),
  );
};

/** Rename / enable-disable a location. Caller passes `{ pathParam: { storeId, locationId }, bodyParam }`. */
export const useUpdateLocationMutation = (storeId: string) => {
  const queryClient = useQueryClient();
  return useMutation(
    UPDATE_LOCATION.mutationOptions<void, UpdateLocationRequest>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: locationKeys.list(storeId) });
      },
    }),
  );
};

/** Set a location as the store default. Caller passes `{ pathParam: { storeId, locationId } }`. */
export const useSetDefaultLocationMutation = (storeId: string) => {
  const queryClient = useQueryClient();
  return useMutation(
    SET_DEFAULT_LOCATION.mutationOptions<void, undefined>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: locationKeys.list(storeId) });
      },
    }),
  );
};

/** Soft-delete a location. Caller passes `{ pathParam: { storeId, locationId } }`. */
export const useDeleteLocationMutation = (storeId: string) => {
  const queryClient = useQueryClient();
  return useMutation(
    DELETE_LOCATION.mutationOptions<void, undefined>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: locationKeys.list(storeId) });
      },
    }),
  );
};