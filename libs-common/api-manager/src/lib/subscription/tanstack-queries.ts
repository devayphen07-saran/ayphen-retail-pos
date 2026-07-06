import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GET_SUBSCRIPTION,
  GET_SUBSCRIPTION_VERSION,
  GET_SUBSCRIPTION_PLANS,
  CREATE_SUBSCRIPTION_CHECKOUT,
  VERIFY_SUBSCRIPTION_PAYMENT,
  CANCEL_SUBSCRIPTION,
  REACTIVATE_SUBSCRIPTION,
  GET_RECONCILIATION,
  RESOLVE_RECONCILIATION,
  SWAP_ACTIVE_STORE,
} from './api-data';
import type {
  SubscriptionResponse,
  SubscriptionVersionResponse,
  PlanCatalogEntry,
  CheckoutSubscriptionRequest,
  CheckoutSubscriptionResponse,
  VerifySubscriptionPaymentRequest,
  VerifySubscriptionPaymentResponse,
  SubscriptionActionResponse,
  ReconciliationResponse,
  ReconciliationRequest,
  ActiveStoreSwapRequest,
} from './types';

export const subscriptionKeys = {
  all:            ['subscription'] as const,
  detail:         () => [...subscriptionKeys.all, 'detail'] as const,
  version:        () => [...subscriptionKeys.all, 'version'] as const,
  plans:          () => [...subscriptionKeys.all, 'plans'] as const,
  reconciliation: () => [...subscriptionKeys.all, 'reconciliation'] as const,
};

/** The freshness re-fetch target (subscription §16/§19). */
export const useSubscriptionQuery = (options?: { enabled?: boolean }) =>
  useQuery({
    ...GET_SUBSCRIPTION.queryOptions<SubscriptionResponse>(),
    queryKey: subscriptionKeys.detail(),
    enabled: options?.enabled ?? true,
  });

/** Cheap poll target — rarely needed directly; the response-header freshness
 *  protocol (interceptors.ts) drives most refetches. Exposed for a manual
 *  pull-to-refresh check. */
export const useSubscriptionVersionQuery = (options?: { enabled?: boolean }) =>
  useQuery({
    ...GET_SUBSCRIPTION_VERSION.queryOptions<SubscriptionVersionResponse>(),
    queryKey: subscriptionKeys.version(),
    enabled: options?.enabled ?? false,
  });

/** Purchasable plan catalog — static config, cache ~24h (§22B). */
export const useSubscriptionPlansQuery = (options?: { enabled?: boolean }) =>
  useQuery({
    ...GET_SUBSCRIPTION_PLANS.queryOptions<PlanCatalogEntry[]>(),
    queryKey: subscriptionKeys.plans(),
    enabled: options?.enabled ?? true,
    staleTime: 24 * 60 * 60 * 1000,
  });

/** Create a Razorpay order for a plan. Does not itself change subscription
 *  state — activation happens on a successful `verify()` — so no invalidation. */
export const useCheckoutSubscriptionMutation = () =>
  useMutation(
    CREATE_SUBSCRIPTION_CHECKOUT.mutationOptions<
      CheckoutSubscriptionResponse,
      CheckoutSubscriptionRequest
    >(),
  );

/** Verify a client-reported payment → activate. Refetch the subscription on
 *  success rather than trusting local optimistic state (§9 step 6). */
export const useVerifySubscriptionPaymentMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    VERIFY_SUBSCRIPTION_PAYMENT.mutationOptions<
      VerifySubscriptionPaymentResponse,
      VerifySubscriptionPaymentRequest
    >({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: subscriptionKeys.detail() });
      },
    }),
  );
};

/** Request cancellation at period end (§12). */
export const useCancelSubscriptionMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    CANCEL_SUBSCRIPTION.mutationOptions<SubscriptionActionResponse, undefined>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: subscriptionKeys.detail() });
      },
    }),
  );
};

/** Undo a pending cancellation, still within the paid period (§13 case A). */
export const useReactivateSubscriptionMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    REACTIVATE_SUBSCRIPTION.mutationOptions<SubscriptionActionResponse, undefined>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: subscriptionKeys.detail() });
      },
    }),
  );
};

/** The downgrade resolve screen's data — meaningful while
 *  `reconciliation_status === 'pending'` on GET /me/subscription. */
export const useReconciliationQuery = (options?: { enabled?: boolean }) =>
  useQuery({
    ...GET_RECONCILIATION.queryOptions<ReconciliationResponse>(),
    queryKey: subscriptionKeys.reconciliation(),
    enabled: options?.enabled ?? true,
  });

/** The owner's downgrade resolution. Invalidates the subscription detail too —
 *  `reconciliation_status` flips to 'applied' on success. */
export const useResolveReconciliationMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    RESOLVE_RECONCILIATION.mutationOptions<{ applied: true }, ReconciliationRequest>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: subscriptionKeys.detail() });
        queryClient.invalidateQueries({ queryKey: subscriptionKeys.reconciliation() });
      },
    }),
  );
};

/** Post-downgrade flexibility — swap which store is active. */
export const useSwapActiveStoreMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    SWAP_ACTIVE_STORE.mutationOptions<{ applied: true }, ActiveStoreSwapRequest>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: subscriptionKeys.detail() });
        queryClient.invalidateQueries({ queryKey: subscriptionKeys.reconciliation() });
      },
    }),
  );
};
