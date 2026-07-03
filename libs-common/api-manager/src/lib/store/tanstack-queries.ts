import { useMutation } from '@tanstack/react-query';
import { CREATE_STORE, CLAIM_STORE_ACCESS } from './api-data';
import type { CreateStoreRequest, CreateStoreResponse, ClaimStoreAccessResponse } from './types';

/** Create a store — onboarding path for a business-mode user with no stores yet. */
export const useCreateStoreMutation = () =>
  useMutation(CREATE_STORE.mutationOptions<CreateStoreResponse, CreateStoreRequest>());

/** Claim (or heartbeat) this device's slot on a store — called on every online store-open. */
export const useClaimStoreAccessMutation = () =>
  useMutation(CLAIM_STORE_ACCESS.mutationOptions<ClaimStoreAccessResponse, void>());
