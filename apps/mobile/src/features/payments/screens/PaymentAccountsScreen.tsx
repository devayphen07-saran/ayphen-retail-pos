import { useCallback, useMemo, useState } from 'react';
import { router } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { AppLayout, IconButton, ListScaffold, SearchBar } from '@ayphen/mobile-ui-components';
import { usePaymentAccountsQuery, type PaymentAccountResponse } from '@ayphen/api-manager';
import { usePermission } from '@core/auth/usePermission';
import { useActiveStoreStore } from '@store';
import { useDebouncedValue } from '../../../utils/useDebouncedValue';
import { PaymentAccountCard } from '../components/PaymentAccountCard';

/**
 * Payment-account management — ONLINE list (react-query over the REST surface).
 * The offline POS checkout reads the same accounts from the local sync cache
 * instead; this admin screen is deliberately online/authoritative.
 */
export function PaymentAccountsScreen() {
  const { theme } = useMobileTheme();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const [search, setSearch] = useState('');
  const canCreate = usePermission('Payment', 'create');

  const { data, isLoading, isFetching, isError, error, refetch } = usePaymentAccountsQuery(storeId);
  const debouncedSearch = useDebouncedValue(search, 200);

  // The server returns a stable, canonical order (default → active → system →
  // name), so we only filter here.
  const accounts = useMemo(() => {
    const rows = data ?? [];
    const term = debouncedSearch.trim().toLowerCase();
    return term ? rows.filter((a) => a.name.toLowerCase().includes(term)) : rows;
  }, [data, debouncedSearch]);

  const addButton = useMemo(
    () =>
      canCreate ? (
        <IconButton
          variant="ghost"
          size={36}
          iconName="Plus"
          color={theme.colorPrimary}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Add payment account"
          hitSlop={8}
          onPress={() => router.push('/(store)/payment-account-create')}
        />
      ) : undefined,
    [theme.colorPrimary, canCreate],
  );

  const renderItem = useCallback(
    ({ item }: { item: PaymentAccountResponse }) => (
      <PaymentAccountCard
        name={item.name}
        isDefault={item.is_default}
        isActive={item.is_active}
        isSystem={item.is_system}
        onPress={() =>
          router.push({ pathname: '/(store)/account-detail', params: { accountGuuid: item.guuid } })
        }
      />
    ),
    [],
  );

  return (
    <AppLayout title="Payment accounts" rightElement={addButton}>
      <SearchBar value={search} onChangeText={setSearch} placeholder="Search accounts…" />

      <ListScaffold<PaymentAccountResponse>
        data={accounts}
        keyExtractor={(item) => item.guuid}
        renderItem={renderItem}
        isThemed
        listProps={{ refetch: () => refetch() }}
        loaderProps={{
          isLoading,
          isFetching,
          loadingCard: () => null,
          loaderLength: 6,
        }}
        emptyState={
          isError
            ? {
                message: "Couldn't load accounts",
                description: error instanceof Error ? error.message : 'Pull to retry.',
                icon: 'TriangleAlert',
              }
            : search
              ? {
                  message: 'No matches',
                  description: 'Try a different search.',
                  icon: 'Search',
                  filterActive: true,
                  onClearFilters: () => setSearch(''),
                }
              : {
                  message: 'No payment accounts',
                  description: 'Tap + to add one. Cash and Bank are set up automatically.',
                  icon: 'Wallet',
                }
        }
      />
    </AppLayout>
  );
}
