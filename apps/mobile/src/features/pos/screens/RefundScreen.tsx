import { useMemo, useState } from 'react';
import { TextInput } from 'react-native';
import styled from 'styled-components/native';
import { eq, and } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';
import { useNetInfo } from '@react-native-community/netinfo';
import { router } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  AppLayout,
  Button,
  Column,
  RadioGroup,
  Row,
  TextArea,
  Typography,
  formatMinorUnits,
} from '@ayphen/mobile-ui-components';
import { getSyncDbForQueries } from '@core/sync/db/client';
import { saleLines, products, paymentAccounts } from '@core/sync/db/schema';
import { enqueueCreateRefund } from '@core/sync/mutations/enqueue-create-refund';
import { showMutationError, withSyncNote } from '@core/sync/mutations/mutation-feedback';
import { useActiveStoreStore } from '@store';

interface Props {
  saleId: string;
  saleGuuid: string;
}

/**
 * F3 — pick how much of each line to refund, the destination account, an
 * optional reason. Quantities entered here are advisory; the server
 * recomputes each refund line's amount and enforces the sale/line caps
 * (refund.handler.ts BR-4/V-9) regardless of what's typed.
 *
 * Integer-only quantity entry for this pass — fractional-quantity refunds
 * (kg/litre lines) aren't wired in the UI yet, though the data model
 * (numeric qty) already supports them.
 */
export function RefundScreen({ saleId, saleGuuid }: Props) {
  const { theme } = useMobileTheme();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const [qtyByLineGuuid, setQtyByLineGuuid] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const net = useNetInfo();
  const isOffline = net.isConnected === false || net.isInternetReachable === false;

  const linesQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select({
          guuid: saleLines.guuid,
          qty: saleLines.qty,
          unitPricePaise: saleLines.unitPricePaise,
          productName: products.name,
        })
        .from(saleLines)
        .leftJoin(products, eq(products.id, saleLines.productFk))
        .where(eq(saleLines.saleFk, saleId)),
    [saleId],
  );
  const { data: lineRows } = useLiveQuery(linesQuery, [saleId]);
  const lines = lineRows ?? [];

  const accountsQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select()
        .from(paymentAccounts)
        .where(and(eq(paymentAccounts.storeId, storeId), eq(paymentAccounts.isActive, true))),
    [storeId],
  );
  const { data: accountRows } = useLiveQuery(accountsQuery, [storeId]);
  const accounts = accountRows ?? [];

  const refundLines = lines
    .map((l) => ({ ...l, qty: Number(qtyByLineGuuid[l.guuid] ?? '0') }))
    .filter((l) => l.qty > 0);
  const estimatedTotalPaise = refundLines.reduce((sum, l) => sum + Math.round(l.qty * l.unitPricePaise), 0);
  const canSubmit = refundLines.length > 0 && !!selectedAccountId && !isSubmitting;

  const handleSubmit = async () => {
    if (!selectedAccountId) return;
    const account = accounts.find((a) => a.id === selectedAccountId);
    if (!account) return;
    setIsSubmitting(true);
    try {
      await enqueueCreateRefund(storeId, {
        saleId,
        saleGuuid,
        accountId: account.id,
        accountGuuid: account.guuid,
        reason: reason.trim() || undefined,
        lines: refundLines.map((l) => ({
          saleLineGuuid: l.guuid,
          qty: l.qty,
          estimatedUnitPricePaise: l.unitPricePaise,
        })),
      });
      Alert.info(
        'Refund recorded',
        withSyncNote(`${formatMinorUnits(estimatedTotalPaise, { currency: 'INR' })} refunded to ${account.name}.`, isOffline),
      );
      router.back();
    } catch {
      showMutationError();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AppLayout title="Refund" onBack={() => router.back()}>
      <Column padding="medium" gap={theme.sizing.medium}>
        <Column gap={theme.sizing.small}>
          {lines.map((line) => (
            <Row key={line.guuid} justify="space-between" align="center">
              <Column gap={0} flex={1}>
                <Typography.Body>{line.productName ?? 'Item'}</Typography.Body>
                <Typography.Caption type="secondary">
                  sold {line.qty} × {formatMinorUnits(line.unitPricePaise, { currency: 'INR' })}
                </Typography.Caption>
              </Column>
              {/*
               * The library's `Input` is RHF-only (requires `name` + `control`)
               * and this screen manages a dynamic per-line-guuid map via plain
               * `useState`, not a form — introducing RHF here for one numeric
               * cell would be a much larger behavioural change than a styling
               * fix warrants. Kept as a themed `TextInput` styled component
               * (tokens only, no inline style) as a documented exception to
               * "always use Input".
               */}
              <QtyInput
                value={qtyByLineGuuid[line.guuid] ?? ''}
                onChangeText={(text) => setQtyByLineGuuid((prev) => ({ ...prev, [line.guuid]: text.replace(/[^0-9]/g, '') }))}
                placeholder="0"
                keyboardType="number-pad"
                editable={!isSubmitting}
              />
            </Row>
          ))}
        </Column>

        <RadioGroup
          label="Refund to"
          options={accounts.map((a) => ({ label: a.name, value: a.id }))}
          value={selectedAccountId}
          onChange={setSelectedAccountId}
          disabled={isSubmitting}
        />

        <TextArea
          label="Reason (optional)"
          value={reason}
          onChange={setReason}
          placeholder="e.g. Customer changed their mind"
          disabled={isSubmitting}
          maxLength={280}
        />

        <Button
          label={`Refund ${formatMinorUnits(estimatedTotalPaise, { currency: 'INR' })}`}
          onPress={handleSubmit}
          disabled={!canSubmit}
          loading={isSubmitting}
        />
      </Column>
    </AppLayout>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const QtyInput = styled(TextInput)`
  width: 56px;
  text-align: center;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
  padding-vertical: ${({ theme }) => theme.sizing.xxSmall}px;
  color: ${({ theme }) => theme.colorText};
`;