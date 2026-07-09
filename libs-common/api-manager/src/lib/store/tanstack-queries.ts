import { useMutation, useQuery } from '@tanstack/react-query';
import { CREATE_STORE, CLAIM_STORE_ACCESS, GET_STORE_SETUP_STATUS } from './api-data';
import type {
  CreateStoreRequest,
  CreateStoreResponse,
  ClaimStoreAccessResponse,
  StoreSetupStatusResponse,
} from './types';

/** Create a store — onboarding path for a business-mode user with no stores yet. */
export const useCreateStoreMutation = () =>
  useMutation(CREATE_STORE.mutationOptions<CreateStoreResponse, CreateStoreRequest>());

/** Claim (or heartbeat) this device's slot on a store — called on every online store-open. */
export const useClaimStoreAccessMutation = () =>
  useMutation(CLAIM_STORE_ACCESS.mutationOptions<ClaimStoreAccessResponse, void>());

export const storeSetupKeys = {
  all:    ['store-setup-status'] as const,
  detail: (storeId: string) => [...storeSetupKeys.all, storeId] as const,
};

/** The store home screen's setup-checklist card data. Computed live server-side
 *  on every fetch — no client-side staleness workaround needed. */
export const useStoreSetupStatusQuery = (storeId: string, options?: { enabled?: boolean }) =>
  useQuery({
    ...GET_STORE_SETUP_STATUS.queryOptions<StoreSetupStatusResponse>({ pathParam: { storeId } }),
    queryKey: storeSetupKeys.detail(storeId),
    enabled: options?.enabled ?? !!storeId,
  });
