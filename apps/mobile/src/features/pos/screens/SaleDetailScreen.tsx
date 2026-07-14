import { useMemo } from 'react';
import { eq } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';
import { router } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { AppLayout, Button, Column, Divider, Row, Typography, formatMinorUnits } from '@ayphen/mobile-ui-components';
import { usePermission } from '@core/auth/usePermission';
import { getSyncDbForQueries } from '@core/sync/db/client';
import { sales, saleLines, salePayments, products } from '@core/sync/db/schema';

const STATUS_LABEL: Record<string, string> = {
  completed: 'Completed',
  partially_refunded: 'Partially refunded',
  refunded: 'Refunded',
};

/** Line items + tender breakdown for one sale, read straight from the local
 *  sync cache. "Refund" is offered while anything is left to refund
 *  (status !== 'refunded') — the server still enforces the real cap
 *  (BR-4/V-9) regardless of what this screen shows. */
export function SaleDetailScreen({ saleGuuid }: { saleGuuid: string }) {
  const { theme } = useMobileTheme();
  const canRefund = usePermission('Refund', 'create');

  const saleQuery = useMemo(
    () => getSyncDbForQueries().select().from(sales).where(eq(sales.guuid, saleGuuid)),
    [saleGuuid],
  );
  const { data: saleRows } = useLiveQuery(saleQuery, [saleGuuid]);
  const sale = saleRows?.[0];

  const linesQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select({
          id: saleLines.id,
          guuid: saleLines.guuid,
          qty: saleLines.qty,
          unitPricePaise: saleLines.unitPricePaise,
          lineTotalPaise: saleLines.lineTotalPaise,
          productName: products.name,
        })
        .from(saleLines)
        .leftJoin(products, eq(products.id, saleLines.productFk))
        .where(eq(saleLines.saleFk, sale?.id ?? '')),
    [sale?.id],
  );
  const { data: lineRows } = useLiveQuery(linesQuery, [sale?.id]);

  const paymentsQuery = useMemo(
    () => getSyncDbForQueries().select().from(salePayments).where(eq(salePayments.saleFk, sale?.id ?? '')),
    [sale?.id],
  );
  const { data: paymentRows } = useLiveQuery(paymentsQuery, [sale?.id]);

  const refundButton =
    canRefund && sale && sale.status !== 'refunded' ? (
      <Button
        label="Refund"
        onPress={() =>
          router.push({ pathname: '/(store)/refund-create', params: { saleId: sale.id, saleGuuid: sale.guuid } })
        }
      />
    ) : null;

  return (
    <AppLayout title={sale?.invoiceNo ?? 'Sale'} onBack={() => router.back()}>
      <Column padding="medium" gap={theme.sizing.medium}>
        <Row justify="space-between">
          <Typography.Caption type="secondary">Status</Typography.Caption>
          <Typography.Body weight="medium">{STATUS_LABEL[sale?.status ?? ''] ?? sale?.status}</Typography.Body>
        </Row>

        <Divider />

        <Column gap={theme.sizing.small}>
          {(lineRows ?? []).map((line) => (
            <Row key={line.id} justify="space-between">
              <Column gap={0} flex={1}>
                <Typography.Body>{line.productName ?? 'Item'}</Typography.Body>
                <Typography.Caption type="secondary">
                  {line.qty} × {formatMinorUnits(line.unitPricePaise, { currency: 'INR' })}
                </Typography.Caption>
              </Column>
              <Typography.Body weight="medium">
                {formatMinorUnits(line.lineTotalPaise, { currency: 'INR' })}
              </Typography.Body>
            </Row>
          ))}
        </Column>

        <Divider />

        <Row justify="space-between">
          <Typography.Body weight="semiBold">Total</Typography.Body>
          <Typography.Body weight="semiBold">
            {formatMinorUnits(sale?.totalPaise ?? 0, { currency: 'INR' })}
          </Typography.Body>
        </Row>

        <Column gap={2}>
          <Typography.Caption type="secondary">Paid via</Typography.Caption>
          {(paymentRows ?? []).map((p) => (
            <Row key={p.id} justify="space-between">
              <Typography.Caption>{p.tender}</Typography.Caption>
              <Typography.Caption>{formatMinorUnits(p.amountPaise, { currency: 'INR' })}</Typography.Caption>
            </Row>
          ))}
        </Column>

        {refundButton}
      </Column>
    </AppLayout>
  );
}