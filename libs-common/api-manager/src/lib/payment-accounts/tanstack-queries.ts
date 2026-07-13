import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GET_PAYMENT_ACCOUNTS,
  CREATE_PAYMENT_ACCOUNT,
  UPDATE_PAYMENT_ACCOUNT,
  DELETE_PAYMENT_ACCOUNT,
} from './api-data';
import type {
  PaymentAccountResponse,
  CreatePaymentAccountRequest,
  UpdatePaymentAccountRequest,
} from './types';

export const paymentAccountKeys = {
  all: ['payment-accounts'] as const,
  list: (storeId: string) => [...paymentAccountKeys.all, storeId] as const,
};

/** Online list of a store's payment accounts (management screen). */
export const usePaymentAccountsQuery = (storeId: string, options?: { enabled?: boolean }) =>
  useQuery({
    ...GET_PAYMENT_ACCOUNTS.queryOptions<PaymentAccountResponse[]>({ pathParam: { storeId } }),
    queryKey: paymentAccountKeys.list(storeId),
    enabled: options?.enabled ?? !!storeId,
  });

/** Create. Caller passes `{ pathParam: { storeId }, bodyParam }`. */
export const useCreatePaymentAccountMutation = (storeId: string) => {
  const queryClient = useQueryClient();
  return useMutation(
    CREATE_PAYMENT_ACCOUNT.mutationOptions<PaymentAccountResponse, CreatePaymentAccountRequest>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: paymentAccountKeys.list(storeId) });
      },
    }),
  );
};

/** Edit. Caller passes `{ pathParam: { storeId, accountId }, bodyParam }`. */
export const useUpdatePaymentAccountMutation = (storeId: string) => {
  const queryClient = useQueryClient();
  return useMutation(
    UPDATE_PAYMENT_ACCOUNT.mutationOptions<PaymentAccountResponse, UpdatePaymentAccountRequest>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: paymentAccountKeys.list(storeId) });
      },
    }),
  );
};

/** Delete. Caller passes `{ pathParam: { storeId, accountId } }`. */
export const useDeletePaymentAccountMutation = (storeId: string) => {
  const queryClient = useQueryClient();
  return useMutation(
    DELETE_PAYMENT_ACCOUNT.mutationOptions<void, undefined>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: paymentAccountKeys.list(storeId) });
      },
    }),
  );
};
