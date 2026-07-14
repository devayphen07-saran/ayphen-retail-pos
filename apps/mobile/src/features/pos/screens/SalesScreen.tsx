import { useCallback, useMemo } from 'react';
import { TouchableOpacity } from 'react-native';
import styled from 'styled-components/native';
import { desc, eq } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';
import { router } from 'expo-router';
import { AppLayout, Column, ListScaffold, Row, Typography, formatMinorUnits } from '@ayphen/mobile-ui-components';
import { getSyncDbForQueries } from '@core/sync/db/client';
import { sales } from '@core/sync/db/schema';
import type { LocalSale } from '@core/sync/repositories/sale.repository';
import { useActiveStoreStore } from '@store';
import { useDebouncedValue } from '../../../utils/useDebouncedValue';

const STATUS_LABEL: Record<string, string> = {
  completed: 'Completed',
  partially_refunded: 'Partially refunded',
  refunded: 'Refunded',
};

/** Recent sales — reads the local `sales` header table directly (list-level
 *  fields only; line/tender detail loads on SaleDetailScreen). */
export function SalesScreen() {
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';

  const query = useMemo(
    () =>
      getSyncDbForQueries()
        .select()
        .from(sales)
        .where(eq(sales.storeId, storeId))
        .orderBy(desc(sales.soldAt)),
    [storeId],
  );
  const { data, error } = useLiveQuery(query, [storeId]);
  const debounced = useDebouncedValue(data, 200);
  const rows = useMemo(() => debounced ?? [], [debounced]);

  const renderItem = useCallback(
    ({ item }: { item: LocalSale }) => (
      <TouchableOpacity
        activeOpacity={0.7}
        accessibilityRole="button"
        onPress={() => router.push({ pathname: '/(store)/sale-detail', params: { saleGuuid: item.guuid } })}
      >
        <SalesRow justify="space-between" align="center">
          <Column gap={2}>
            <Typography.Body weight="medium">{item.invoiceNo ?? 'Pending sync…'}</Typography.Body>
            <Typography.Caption type="secondary">
              {item.soldAt ? new Date(item.soldAt).toLocaleString() : ''} · {STATUS_LABEL[item.status ?? ''] ?? item.status}
            </Typography.Caption>
          </Column>
          <Typography.Body weight="semiBold">
            {formatMinorUnits(item.totalPaise, { currency: 'INR' })}
          </Typography.Body>
        </SalesRow>
      </TouchableOpacity>
    ),
    [],
  );

  return (
    <AppLayout title="Sales">
      <ListScaffold<LocalSale>
        data={rows}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        isThemed
        listProps={{ refetch: () => undefined }}
        loaderProps={{ isLoading: false, isFetching: false, loadingCard: () => null, loaderLength: 0 }}
        emptyState={
          error
            ? { message: "Couldn't load sales", description: error.message, icon: 'TriangleAlert' }
            : { message: 'No sales yet', description: 'Sales from the POS screen will appear here.', icon: 'Receipt' }
        }
      />
    </AppLayout>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const SalesRow = styled(Row)`
  padding-vertical: ${({ theme }) => theme.sizing.small}px;
  padding-horizontal: ${({ theme }) => theme.sizing.medium}px;
`;