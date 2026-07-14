import { useMemo, useState } from 'react';
import { eq, and } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';
import { useNetInfo } from '@react-native-community/netinfo';
import { router } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  AmountInput,
  AppLayout,
  Button,
  Column,
  RadioGroup,
  Typography,
  formatMinorUnits,
} from '@ayphen/mobile-ui-components';
import { getSyncDbForQueries } from '@core/sync/db/client';
import {
  sales,
  salePayments,
  paymentAllocations,
  paymentAccounts,
} from '@core/sync/db/schema';
import { enqueueCreateCustomerPayment } from '@core/sync/mutations/enqueue-create-customer-payment';
import { showMutationError, withSyncNote } from '@core/sync/mutations/mutation-feedback';
import { useActiveStoreStore } from '@store';
import { allocateFifo, computeOpenCreditSales } from '../utils/credit-sales';

interface Props {
  customerId: string;
  customerGuuid: string;
  customerName: string;
}

/**
 * F5 settlement — "pay down my tab." Simplification: one amount, allocated
 * FIFO (oldest sale first) across the customer's open credit sales, rather
 * than a per-sale allocation UI. The server still validates every individual
 * allocation against that sale's remaining credit (BR-6) regardless of how
 * this screen chose to split it.
 */
export function CollectPaymentScreen({
  customerId,
  customerGuuid,
  customerName,
}: Props) {
  const { theme } = useMobileTheme();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const [amountPaise, setAmountPaise] = useState<number | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<
    string | undefined
  >(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const net = useNetInfo();
  const isOffline = net.isConnected === false || net.isInternetReachable === false;

  const salesQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select()
        .from(sales)
        .where(eq(sales.customerFk, customerId)),
    [customerId],
  );
  const { data: customerSales } = useLiveQuery(salesQuery, [customerId]);

  const paymentsQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select()
        .from(salePayments)
        .where(eq(salePayments.storeId, storeId)),
    [storeId],
  );
  const { data: allPayments } = useLiveQuery(paymentsQuery, [storeId]);

  const allocationsQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select()
        .from(paymentAllocations)
        .where(eq(paymentAllocations.storeId, storeId)),
    [storeId],
  );
  const { data: allAllocations } = useLiveQuery(allocationsQuery, [storeId]);

  const openSales = useMemo(
    () =>
      computeOpenCreditSales(
        customerSales ?? [],
        allPayments ?? [],
        allAllocations ?? [],
      ),
    [customerSales, allPayments, allAllocations],
  );
  const totalOutstandingPaise = openSales.reduce(
    (sum, s) => sum + s.remainingPaise,
    0,
  );

  const accountsQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select()
        .from(paymentAccounts)
        .where(
          and(
            eq(paymentAccounts.storeId, storeId),
            eq(paymentAccounts.isActive, true),
          ),
        ),
    [storeId],
  );
  const { data: accountRows } = useLiveQuery(accountsQuery, [storeId]);
  const accounts = accountRows ?? [];

  const canSubmit =
    !!amountPaise &&
    amountPaise > 0 &&
    // Cap at the total outstanding — allocateFifo() only ever allocates up to
    // each sale's remaining, so any entered amount above this would be
    // silently truncated (the excess sent nowhere) while the success message
    // still reported the full typed amount. Mirrors PaySupplierBillScreen's
    // equivalent guard for the same "pay down a balance" shape.
    amountPaise <= totalOutstandingPaise &&
    !!selectedAccountId &&
    !isSubmitting &&
    openSales.length > 0;

  const handleSubmit = async () => {
    if (!amountPaise || !selectedAccountId) return;
    const account = accounts.find((a) => a.id === selectedAccountId);
    if (!account) return;
    const allocations = allocateFifo(amountPaise, openSales);
    if (allocations.length === 0) return;
    setIsSubmitting(true);
    try {
      await enqueueCreateCustomerPayment(storeId, {
        customerId,
        customerGuuid,
        accountId: account.id,
        accountGuuid: account.guuid,
        allocations,
      });
      Alert.info(
        'Payment recorded',
        withSyncNote(`${formatMinorUnits(amountPaise, { currency: 'INR' })} collected from ${customerName}.`, isOffline),
      );
      router.back();
    } catch {
      showMutationError();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AppLayout
      title={`Collect payment · ${customerName}`}
      onBack={() => router.back()}
    >
      <Column
        padding={theme.sizing.medium}
        gap={theme.sizing.medium}
      >
        <Typography.Caption type="secondary">
          Total outstanding:{' '}
          {formatMinorUnits(totalOutstandingPaise, { currency: 'INR' })}
        </Typography.Caption>

        <AmountInput
          currency="INR"
          label="Amount"
          required
          value={amountPaise}
          onChange={setAmountPaise}
          disabled={isSubmitting}
        />

        <RadioGroup
          label="Deposit to"
          options={accounts.map((a) => ({ label: a.name, value: a.id }))}
          value={selectedAccountId}
          onChange={setSelectedAccountId}
          disabled={isSubmitting}
        />

        <Button
          label={`Collect ${formatMinorUnits(amountPaise ?? 0, { currency: 'INR' })}`}
          onPress={handleSubmit}
          disabled={!canSubmit}
          loading={isSubmitting}
        />
      </Column>
    </AppLayout>
  );
}
