import { useState } from 'react';
import { router } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { AmountInput, AppLayout, Button, Column, TextArea } from '@ayphen/mobile-ui-components';
import { enqueueCreateSupplierBill } from '@core/sync/mutations/enqueue-create-supplier-bill';
import { showMutationError } from '@core/sync/mutations/mutation-feedback';
import { useActiveStoreStore } from '@store';

interface Props {
  supplierId: string;
  supplierGuuid: string;
}

/** F6 — record what a vendor billed us. Flat create, no lines. */
export function CreateSupplierBillScreen({ supplierId, supplierGuuid }: Props) {
  const { theme } = useMobileTheme();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const [billNo, setBillNo] = useState('');
  const [amountPaise, setAmountPaise] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canSubmit = !!amountPaise && amountPaise > 0 && !isSubmitting;

  const handleSubmit = async () => {
    if (!amountPaise) return;
    setIsSubmitting(true);
    try {
      await enqueueCreateSupplierBill(storeId, {
        supplierId,
        supplierGuuid,
        billNo: billNo.trim() || undefined,
        amountPaise,
        notes: notes.trim() || undefined,
      });
      router.back();
    } catch {
      showMutationError();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AppLayout title="Add bill" onBack={() => router.back()}>
      <Column padding={theme.sizing.medium} gap={theme.sizing.medium}>
        <TextArea
          label="Bill number (optional)"
          value={billNo}
          onChange={setBillNo}
          placeholder="e.g. INV-2024-118"
          disabled={isSubmitting}
          maxLength={60}
          multiline={false}
          numberOfLines={1}
          minHeight={44}
        />

        <AmountInput currency="INR" label="Amount" required value={amountPaise} onChange={setAmountPaise} disabled={isSubmitting} />

        <TextArea
          label="Notes (optional)"
          value={notes}
          onChange={setNotes}
          placeholder="e.g. Monthly stock order"
          disabled={isSubmitting}
          maxLength={280}
        />

        <Button
          label="Save bill"
          onPress={handleSubmit}
          disabled={!canSubmit}
          loading={isSubmitting}
        />
      </Column>
    </AppLayout>
  );
}