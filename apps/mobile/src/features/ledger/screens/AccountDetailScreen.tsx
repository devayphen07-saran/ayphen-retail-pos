import { useCallback, useMemo, useState } from 'react';
import { eq } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';
import { router } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  AppLayout,
  Column,
  IconButton,
  ListScaffold,
  SegmentedTabs,
  Typography,
  formatMinorUnits,
} from '@ayphen/mobile-ui-components';
import { usePermission } from '@core/auth/usePermission';
import { getSyncDbForQueries } from '@core/sync/db/client';
import { paymentAccounts, accountTransactions, cashMovements } from '@core/sync/db/schema';
import { useActiveStoreStore } from '@store';
import { useDebouncedValue } from '../../../utils/useDebouncedValue';
import { LedgerRowCard } from '../components/LedgerRowCard';
import { computeBalancePaise, mergeLedgerRows, type LedgerRow } from '../utils/ledger-row';

type FilterKey = 'all' | 'in' | 'out';

/**
 * "Tap Cash → see cash in/out" (docs/prd/accounts-and-ledger.md §5). Reads two
 * local tables and merges them (utils/ledger-row.ts): the server-confirmed
 * `account_transactions` projection (the balance's source of truth, D-SD2)
 * plus any locally-queued `cash_movements` still awaiting their posting —
 * without the merge, a movement the user just added would be invisible until
 * the next sync round-trip, unlike every other local-write screen in the app
 * where the write target IS the read target.
 */
export function AccountDetailScreen({ accountGuuid }: { accountGuuid: string }) {
  const { theme } = useMobileTheme();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const [filter, setFilter] = useState<FilterKey>('all');
  const canAdd = usePermission('CashMovement', 'create');

  const accountQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select()
        .from(paymentAccounts)
        .where(eq(paymentAccounts.guuid, accountGuuid)),
    [accountGuuid],
  );
  const { data: accountRows } = useLiveQuery(accountQuery, [accountGuuid]);
  const account = accountRows?.[0];
  const accountId = account?.id ?? '';

  const transactionsQuery = useMemo(
    () => getSyncDbForQueries().select().from(accountTransactions).where(eq(accountTransactions.accountFk, accountId)),
    [accountId],
  );
  const { data: confirmedRows, error: confirmedError } = useLiveQuery(transactionsQuery, [accountId]);

  const movementsQuery = useMemo(
    () => getSyncDbForQueries().select().from(cashMovements).where(eq(cashMovements.accountFk, accountId)),
    [accountId],
  );
  const { data: movementRows } = useLiveQuery(movementsQuery, [accountId]);

  // Cold-start/delta pages upsert many rows at once — see CustomersScreen for
  // the same debounce-the-live-query-burst rationale.
  const debouncedConfirmed = useDebouncedValue(confirmedRows, 200);
  const debouncedMovements = useDebouncedValue(movementRows, 200);
  const confirmed = useMemo(() => debouncedConfirmed ?? [], [debouncedConfirmed]);

  const allRows = useMemo(
    () => mergeLedgerRows(confirmed, debouncedMovements ?? []),
    [confirmed, debouncedMovements],
  );
  const filtered = useMemo(() => {
    if (filter === 'in') return allRows.filter((r) => r.direction === 'credit');
    if (filter === 'out') return allRows.filter((r) => r.direction === 'debit');
    return allRows;
  }, [allRows, filter]);

  const balancePaise = useMemo(() => computeBalancePaise(confirmed), [confirmed]);

  const addButton = useMemo(
    () =>
      canAdd && account ? (
        <IconButton
          variant="ghost"
          size={36}
          iconName="Plus"
          color={theme.colorPrimary}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Add transaction"
          hitSlop={8}
          onPress={() =>
            router.push({
              pathname: '/(store)/cash-movement-create',
              params: { accountId: account.id, accountGuuid: account.guuid, accountName: account.name },
            })
          }
        />
      ) : undefined,
    [theme.colorPrimary, canAdd, account],
  );

  const renderItem = useCallback(({ item }: { item: LedgerRow }) => <LedgerRowCard row={item} />, []);

  return (
    <AppLayout title={account?.name ?? 'Account'} onBack={() => router.back()} rightElement={addButton}>
      <ScreenPad gap={theme.sizing.xxSmall}>
        <Typography.Caption type="secondary">Balance</Typography.Caption>
        <Typography.H5 weight="bold">{formatMinorUnits(balancePaise, { currency: 'INR' })}</Typography.H5>
      </ScreenPad>

      <SegmentedTabs
        items={[
          { key: 'all', label: 'All' },
          { key: 'in', label: 'Cash In' },
          { key: 'out', label: 'Cash Out' },
        ]}
        selectedKey={filter}
        onChange={(key) => setFilter(key as FilterKey)}
        size="small"
      />

      <ListScaffold<LedgerRow>
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        isThemed
        listProps={{ refetch: () => undefined }}
        loaderProps={{ isLoading: false, isFetching: false, loadingCard: () => null, loaderLength: 0 }}
        emptyState={
          confirmedError
            ? { message: "Couldn't load transactions", description: confirmedError.message, icon: 'TriangleAlert' }
            : {
                message: 'No transactions yet',
                description: canAdd ? 'Tap + to record cash in or out.' : 'Nothing recorded for this account yet.',
                icon: 'Wallet',
              }
        }
      />
    </AppLayout>
  );
}

const ScreenPad = styled(Column)`
  padding-horizontal: ${({ theme }) => theme.sizing.medium}px;
  padding-top: ${({ theme }) => theme.sizing.small}px;
  padding-bottom: ${({ theme }) => theme.sizing.small}px;
`;