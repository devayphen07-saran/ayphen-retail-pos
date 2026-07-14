import { useMemo, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { eq, and } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';
import { useNetInfo } from '@react-native-community/netinfo';
import { router } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Alert, AmountInput, AppLayout, Button, Column, RadioGroup, Typography, formatMinorUnits } from '@ayphen/mobile-ui-components';
import { useRecordImage } from '@features/attachments';
import { getSyncDbForQueries } from '@core/sync/db/client';
import { paymentAccounts } from '@core/sync/db/schema';
import { enqueueCreateSupplierPayment } from '@core/sync/mutations/enqueue-create-supplier-payment';
import { showMutationError, withSyncNote } from '@core/sync/mutations/mutation-feedback';
import { useActiveStoreStore, useAuthStore } from '@store';
import { SupplierPaymentSignatureField } from '../components/SupplierPaymentSignatureField';

interface Props {
  supplierId: string;
  supplierGuuid: string;
  billId: string;
  billGuuid: string;
  billNo: string;
  remainingPaise: string;
}

/**
 * F6 — "vendor click, enter payment, select account, signature, and pay."
 * The signature is captured against this payment's pre-generated guuid
 * before Pay (SupplierPaymentSignatureField, mirrors ProductImageCaptureField);
 * Pay itself is gated on a local capture existing (useRecordImage), not on
 * it having finished uploading — same offline-first posture as the rest of
 * this feature.
 */
export function PaySupplierBillScreen({ supplierId, supplierGuuid, billId, billGuuid, billNo, remainingPaise }: Props) {
  const { theme } = useMobileTheme();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const userId = useAuthStore((s) => s.snapshot?.userId) ?? '';
  const [paymentGuuid] = useState(() => Crypto.randomUUID());
  const [amountPaise, setAmountPaise] = useState<number | null>(Number(remainingPaise) || null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const net = useNetInfo();
  const isOffline = net.isConnected === false || net.isInternetReachable === false;

  const localSignature = useRecordImage(paymentGuuid);

  const accountsQuery = useMemo(
    () => getSyncDbForQueries().select().from(paymentAccounts).where(and(eq(paymentAccounts.storeId, storeId), eq(paymentAccounts.isActive, true))),
    [storeId],
  );
  const { data: accountRows } = useLiveQuery(accountsQuery, [storeId]);
  const accounts = accountRows ?? [];

  const canSubmit =
    !!amountPaise && amountPaise > 0 && amountPaise <= Number(remainingPaise) && !!selectedAccountId && !!localSignature && !isSubmitting;

  const handleSubmit = async () => {
    if (!amountPaise || !selectedAccountId) return;
    const account = accounts.find((a) => a.id === selectedAccountId);
    if (!account) return;
    setIsSubmitting(true);
    try {
      await enqueueCreateSupplierPayment(
        storeId,
        {
          supplierId,
          supplierGuuid,
          accountId: account.id,
          accountGuuid: account.guuid,
          allocations: [{ billGuuid, appliedPaise: amountPaise }],
        },
        paymentGuuid,
      );
      Alert.info(
        'Payment recorded',
        withSyncNote(`${formatMinorUnits(amountPaise, { currency: 'INR' })} paid from ${account.name}.`, isOffline),
      );
      router.back();
    } catch {
      showMutationError();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AppLayout title={`Pay · ${billNo || 'Bill'}`} onBack={() => router.back()}>
      <Column padding={theme.sizing.medium} gap={theme.sizing.medium}>
        <Typography.Caption type="secondary">
          Remaining on this bill: {formatMinorUnits(Number(remainingPaise) || 0, { currency: 'INR' })}
        </Typography.Caption>

        <AmountInput currency="INR" label="Amount" required value={amountPaise} onChange={setAmountPaise} disabled={isSubmitting} />

        <RadioGroup
          label="Pay from"
          options={accounts.map((a) => ({ label: a.name, value: a.id }))}
          value={selectedAccountId}
          onChange={setSelectedAccountId}
          disabled={isSubmitting}
        />

        <SupplierPaymentSignatureField storeId={storeId} paymentGuuid={paymentGuuid} userId={userId} disabled={isSubmitting} />

        <Button
          label={`Pay ${formatMinorUnits(amountPaise ?? 0, { currency: 'INR' })}`}
          onPress={handleSubmit}
          disabled={!canSubmit}
          loading={isSubmitting}
        />
      </Column>
    </AppLayout>
  );
}