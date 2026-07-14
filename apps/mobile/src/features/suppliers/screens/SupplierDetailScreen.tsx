import { useCallback, useMemo } from 'react';
import { TouchableOpacity } from 'react-native';
import styled from 'styled-components/native';
import { eq } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';
import { router } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { AppLayout, Column, IconButton, Row, Typography, formatMinorUnits } from '@ayphen/mobile-ui-components';
import { usePermission } from '@core/auth/usePermission';
import { getSyncDbForQueries } from '@core/sync/db/client';
import { suppliers, supplierBills, paymentAllocations } from '@core/sync/db/schema';
import { useActiveStoreStore } from '@store';
import { computeOpenBills } from '../utils/open-bills';

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  partially_paid: 'Partially paid',
  paid: 'Paid',
};

/** `Row` only exposes a uniform `padding` prop — this needs vertical-only. */
const BillRow = styled(Row)`
  padding-top: ${({ theme }) => theme.sizing.small}px;
  padding-bottom: ${({ theme }) => theme.sizing.small}px;
`;

/** A vendor's payable — open bills + a way into paying one down (F6). */
export function SupplierDetailScreen({ supplierGuuid }: { supplierGuuid: string }) {
  const { theme } = useMobileTheme();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const canCreateBill = usePermission('SupplierBill', 'create');
  const canPay = usePermission('SupplierPayment', 'create');

  const supplierQuery = useMemo(
    () => getSyncDbForQueries().select().from(suppliers).where(eq(suppliers.guuid, supplierGuuid)),
    [supplierGuuid],
  );
  const { data: supplierRows } = useLiveQuery(supplierQuery, [supplierGuuid]);
  const supplier = supplierRows?.[0];

  const billsQuery = useMemo(
    () => getSyncDbForQueries().select().from(supplierBills).where(eq(supplierBills.supplierFk, supplier?.id ?? '')),
    [supplier?.id],
  );
  const { data: billRows } = useLiveQuery(billsQuery, [supplier?.id]);
  const bills = billRows ?? [];

  const allocationsQuery = useMemo(
    () => getSyncDbForQueries().select().from(paymentAllocations).where(eq(paymentAllocations.storeId, storeId)),
    [storeId],
  );
  const { data: allocationRows } = useLiveQuery(allocationsQuery, [storeId]);

  const openBills = useMemo(
    () => computeOpenBills(bills, allocationRows ?? []),
    [bills, allocationRows],
  );
  const totalOutstandingPaise = openBills.reduce((sum, b) => sum + b.remainingPaise, 0);

  const addBillButton = canCreateBill ? (
    <IconButton
      variant="ghost"
      size={36}
      iconName="Plus"
      color={theme.colorPrimary}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel="Add bill"
      hitSlop={8}
      onPress={() =>
        supplier &&
        router.push({
          pathname: '/(store)/supplier-bill-create',
          params: { supplierId: supplier.id, supplierGuuid: supplier.guuid },
        })
      }
    />
  ) : undefined;

  const renderBill = useCallback(
    (bill: (typeof bills)[number]) => {
      const open = openBills.find((b) => b.billId === bill.id);
      const canPayThis = canPay && open;
      return (
        <TouchableOpacity
          key={bill.id}
          activeOpacity={canPayThis ? 0.7 : 1}
          disabled={!canPayThis}
          onPress={() =>
            open &&
            supplier &&
            router.push({
              pathname: '/(store)/supplier-bill-pay',
              params: {
                supplierId: supplier.id,
                supplierGuuid: supplier.guuid,
                billId: open.billId,
                billGuuid: open.billGuuid,
                billNo: open.billNo ?? '',
                remainingPaise: String(open.remainingPaise),
              },
            })
          }
        >
          <BillRow justify="space-between" align="center">
            <Column gap={theme.sizing.xxSmall}>
              <Typography.Body weight="medium">{bill.billNo ?? 'Bill'}</Typography.Body>
              <Typography.Caption type="secondary">
                {bill.billDate ? new Date(bill.billDate).toLocaleDateString() : ''} ·{' '}
                {STATUS_LABEL[bill.status ?? ''] ?? bill.status}
              </Typography.Caption>
            </Column>
            <Typography.Body weight="semiBold">{formatMinorUnits(bill.amountPaise, { currency: 'INR' })}</Typography.Body>
          </BillRow>
        </TouchableOpacity>
      );
    },
    [openBills, canPay, supplier, theme],
  );

  return (
    <AppLayout title={supplier?.name ?? 'Supplier'} onBack={() => router.back()} rightElement={addBillButton}>
      <Column padding={theme.sizing.medium} gap={theme.sizing.medium}>
        <Column gap={theme.sizing.xxSmall}>
          <Typography.Caption type="secondary">Payable</Typography.Caption>
          <Typography.H5 weight="bold">{formatMinorUnits(totalOutstandingPaise, { currency: 'INR' })}</Typography.H5>
        </Column>

        <Column gap={theme.sizing.small}>
          <Typography.Caption type="secondary">Bills</Typography.Caption>
          {bills.length === 0 ? (
            <Typography.Caption type="secondary">No bills recorded yet.</Typography.Caption>
          ) : (
            bills.map((b) => renderBill(b))
          )}
        </Column>
      </Column>
    </AppLayout>
  );
}