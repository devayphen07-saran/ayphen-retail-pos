import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { useNetInfo } from '@react-native-community/netinfo';
import { router } from 'expo-router';
import { and, eq } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';

import { usePermission } from '@core/auth/usePermission';
import { getSyncDbForQueries } from '@core/sync/db/client';
import {
  customerLedgerEvents,
  customers,
  paymentAccounts,
} from '@core/sync/db/schema';
import { enqueueCreateSale } from '@core/sync/mutations/enqueue-create-sale';
import {
  computeOutstandingPaise,
  creditLimitPaise,
} from '@features/customers/utils/outstanding';
import { useActiveStoreStore } from '@store';

import {
  CartScreen,
  type CommitSelection,
} from './checkout/CartScreen';
import { usePosCartStore } from '../store/cart-store';
import { cartTotalPaise } from '../types/cart';

type SaleTender =
  | 'cash'
  | 'card'
  | 'upi'
  | 'wallet'
  | 'other';

function tenderForAccount(
  kind: string | null,
): SaleTender {
  switch (kind) {
    case 'cash':
    case 'card':
    case 'upi':
    case 'wallet':
    case 'other':
      return kind;

    case 'bank':
      return 'other';

    default:
      return 'cash';
  }
}

function isValidQuantity(
  quantity: number,
): boolean {
  if (
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    return false;
  }

  const scaled = quantity * 1_000;

  return (
    Number.isSafeInteger(
      Math.round(scaled),
    ) &&
    Math.abs(
      scaled - Math.round(scaled),
    ) < 1e-9
  );
}

export function CartRoute() {
  const storeId =
    useActiveStoreStore(
      (state) => state.storeId,
    ) ?? '';

  const canSell = usePermission('Sale', 'create');

  const lines = usePosCartStore(
    (state) => state.lines,
  );
  const selectedCustomer =
    usePosCartStore(
      (state) =>
        state.selectedCustomer,
    );
  const bindStore = usePosCartStore(
    (state) => state.bindStore,
  );
  const changeQty = usePosCartStore(
    (state) => state.changeQty,
  );
  const removeLine = usePosCartStore(
    (state) => state.removeLine,
  );
  const setSelectedCustomer =
    usePosCartStore(
      (state) =>
        state.setSelectedCustomer,
    );
  const clear = usePosCartStore(
    (state) => state.clear,
  );

  const submissionInProgressRef =
    useRef(false);

  /*
   * Once committed, the cart is intentionally empty while the success screen
   * remains mounted. This flag prevents the empty-cart redirect in that state.
   */
  const committedRef = useRef(false);

  useEffect(() => {
    bindStore(storeId);
  }, [bindStore, storeId]);

  useEffect(() => {
    if (
      lines.length === 0 &&
      !committedRef.current
    ) {
      router.back();
    }
  }, [lines.length]);

  const totalPaise = useMemo(
    () => cartTotalPaise(lines),
    [lines],
  );

  const totalUnits = useMemo(
    () =>
      lines.reduce(
        (sum, line) =>
          sum + line.qty,
        0,
      ),
    [lines],
  );

  const accountsQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select()
        .from(paymentAccounts)
        .where(
          and(
            eq(
              paymentAccounts.storeId,
              storeId,
            ),
            eq(
              paymentAccounts.isActive,
              true,
            ),
          ),
        ),
    [storeId],
  );

  const { data: accountRows } =
    useLiveQuery(
      accountsQuery,
      [storeId],
    );

  const accounts = useMemo(
    () =>
      (accountRows ?? []).filter(
        (account) =>
          account.storeId ===
          storeId,
      ),
    [accountRows, storeId],
  );

  const customersQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select()
        .from(customers)
        .where(
          and(
            eq(
              customers.storeId,
              storeId,
            ),
            eq(
              customers.isActive,
              true,
            ),
          ),
        ),
    [storeId],
  );

  const { data: customerRows } =
    useLiveQuery(
      customersQuery,
      [storeId],
    );

  const allCustomers = useMemo(
    () =>
      (customerRows ?? []).filter(
        (customer) =>
          customer.storeId ===
          storeId,
      ),
    [customerRows, storeId],
  );

  /*
   * Clear a selected customer if it is removed, deactivated or belongs to the
   * previously active store. Wait for the live query's initial result before
   * making that decision.
   */
  useEffect(() => {
    if (
      !selectedCustomer ||
      customerRows === undefined
    ) {
      return;
    }

    const stillAvailable =
      allCustomers.some(
        (customer) =>
          customer.id ===
            selectedCustomer.id &&
          customer.guuid ===
            selectedCustomer.guuid,
      );

    if (!stillAvailable) {
      setSelectedCustomer(undefined);
    }
  }, [
    allCustomers,
    customerRows,
    selectedCustomer,
    setSelectedCustomer,
  ]);

  const ledgerQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select()
        .from(customerLedgerEvents)
        .where(
          and(
            eq(
              customerLedgerEvents.storeId,
              storeId,
            ),
            eq(
              customerLedgerEvents.customerFk,
              selectedCustomer?.id ?? '',
            ),
          ),
        ),
    [selectedCustomer?.id, storeId],
  );

  const { data: ledgerRows } =
    useLiveQuery(
      ledgerQuery,
      [
        selectedCustomer?.id,
        storeId,
      ],
    );

  const outstandingPaise = useMemo(
    () =>
      computeOutstandingPaise(
        (ledgerRows ?? []).filter(
          (event) =>
            event.storeId === storeId,
        ),
      ),
    [ledgerRows, storeId],
  );

  const limitPaise =
    creditLimitPaise(
      selectedCustomer?.creditLimit,
    );

  const remainingPaise =
    limitPaise > 0
      ? limitPaise -
        outstandingPaise
      : Number.POSITIVE_INFINITY;

  const overLimit =
    selectedCustomer !== undefined &&
    !selectedCustomer.overrideCreditLimit &&
    limitPaise > 0 &&
    outstandingPaise +
      totalPaise >
      limitPaise;

  const netInfo = useNetInfo();

  const isOffline =
    netInfo.isConnected === false ||
    netInfo.isInternetReachable ===
      false;

  const commitSale = useCallback(
    async (
      selection: CommitSelection,
    ): Promise<void> => {
      if (
        submissionInProgressRef.current ||
        !canSell ||
        !storeId ||
        lines.length === 0 ||
        !Number.isSafeInteger(
          totalPaise,
        ) ||
        totalPaise <= 0
      ) {
        throw new Error(
          'Sale cannot be recorded right now.',
        );
      }

      const hasInvalidLine =
        lines.some(
          (line) =>
            !line.productId ||
            !line.productGuuid ||
            !isValidQuantity(
              line.qty,
            ) ||
            !Number.isSafeInteger(
              line.unitPricePaise,
            ) ||
            line.unitPricePaise < 0,
        );

      if (hasInvalidLine) {
        throw new Error(
          'The cart contains an invalid line.',
        );
      }

      const saleLines = lines.map(
        (line) => ({
          productId:
            line.productId,
          productGuuid:
            line.productGuuid,
          qty: line.qty,
          unitPricePaise:
            line.unitPricePaise,
        }),
      );

      submissionInProgressRef.current =
        true;

      try {
        if (
          selection.kind ===
          'credit'
        ) {
          const customer =
            allCustomers.find(
              (candidate) =>
                candidate.id ===
                  selection.customer.id &&
                candidate.guuid ===
                  selection.customer
                    .guuid,
            );

          if (!customer) {
            throw new Error(
              'The selected customer is no longer available.',
            );
          }

          await enqueueCreateSale(
            storeId,
            {
              lines: saleLines,
              payments: [
                {
                  tender: 'other',
                  amountPaise:
                    totalPaise,
                  onCredit: true,
                },
              ],
              customerGuuid:
                customer.guuid,
            },
          );
        } else {
          const account =
            accounts.find(
              (candidate) =>
                candidate.id ===
                  selection.account.id &&
                candidate.guuid ===
                  selection.account
                    .guuid,
            );

          if (!account) {
            throw new Error(
              'The selected payment account is no longer available.',
            );
          }

          await enqueueCreateSale(
            storeId,
            {
              lines: saleLines,
              payments: [
                {
                  accountId:
                    account.id,
                  accountGuuid:
                    account.guuid,
                  tender:
                    tenderForAccount(
                      account.kind,
                    ),
                  amountPaise:
                    totalPaise,
                },
              ],
            },
          );
        }

        /*
         * Set this before clearing the store so the empty-cart effect cannot
         * navigate away from the success screen.
         */
        committedRef.current = true;
        clear();
      } finally {
        submissionInProgressRef.current =
          false;
      }
    },
    [
      accounts,
      allCustomers,
      canSell,
      clear,
      lines,
      storeId,
      totalPaise,
    ],
  );

  const handleClose = useCallback(
    () => {
      router.back();
    },
    [],
  );

  return (
    <CartScreen
      lines={lines}
      totalPaise={totalPaise}
      totalUnits={totalUnits}
      accounts={accounts}
      customers={allCustomers}
      selectedCustomer={
        selectedCustomer
      }
      onSetCustomer={
        setSelectedCustomer
      }
      onChangeQty={changeQty}
      onRemove={removeLine}
      onClear={clear}
      onClose={handleClose}
      onCommit={commitSale}
      overLimit={overLimit}
      remainingPaise={
        remainingPaise
      }
      limitPaise={limitPaise}
      isOffline={isOffline}
    />
  );
}