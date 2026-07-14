import { useCallback, useMemo, useState } from 'react';
import { eq } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';
import { router } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  AppLayout,
  IconButton,
  ListScaffold,
  SearchBar,
} from '@ayphen/mobile-ui-components';
import { usePermission } from '@core/auth/usePermission';
import { getSyncDbForQueries } from '@core/sync/db/client';
import { customers } from '@core/sync/db/schema';
import type { LocalCustomer } from '@core/sync/repositories/customer.repository';
import { useActiveStoreStore } from '@store';
import { useDebouncedValue } from '../../../utils/useDebouncedValue';
import { usePrefetchStates } from '../../../components/StateSelect';
import { CustomerCard } from '../components/CustomerCard';

/**
 * Customers tab — real local data via the sync engine's `customers` table
 * (drizzle-orm/expo-sqlite's `useLiveQuery` re-runs the query on every local
 * write/pull, no manual refetch wiring). Search is local-only. The balance
 * filter the shell used to render is gone — `customer.balance` doesn't exist
 * locally (no ledger/order write handlers yet), so a filter that can't filter
 * would be exactly the stub-that-looks-real this screen used to be.
 */
export function CustomersScreen() {
  const { theme } = useMobileTheme();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const [search, setSearch] = useState('');
  // Warm the states cache so the address State dropdown works when the create
  // form is opened next (even offline within this session).
  usePrefetchStates();
  // Local UX gating only — the create is still enforced server-side.
  const canCreateCustomer = usePermission('Customer', 'create');

  const query = useMemo(
    () => getSyncDbForQueries().select().from(customers).where(eq(customers.storeId, storeId)),
    [storeId],
  );
  const { data, error } = useLiveQuery(query, [storeId]);
  // A delta/cold-start page upserting many rows fires expo-sqlite's per-ROW
  // change hook that many times; debounce the value to coalesce the burst.
  const debouncedData = useDebouncedValue(data, 200);
  const allCustomers = useMemo(() => debouncedData ?? [], [debouncedData]);

  const debouncedSearch = useDebouncedValue(search, 200);
  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    if (!term) return allCustomers;
    return allCustomers.filter(
      (c) =>
        c.name.toLowerCase().includes(term) ||
        (c.phone?.toLowerCase().includes(term) ?? false) ||
        (c.email?.toLowerCase().includes(term) ?? false),
    );
  }, [allCustomers, debouncedSearch]);

  const addButton = useMemo(
    () =>
      canCreateCustomer ? (
        <IconButton
          variant="ghost"
          size={36}
          iconName="Plus"
          color={theme.colorPrimary}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Add customer"
          hitSlop={8}
          onPress={() => router.push('/(store)/customer-create')}
        />
      ) : undefined,
    [theme.colorPrimary, canCreateCustomer],
  );

  const renderItem = useCallback(
    ({ item }: { item: LocalCustomer }) => (
      <CustomerCard
        customer={item}
        onPress={() => router.push({ pathname: '/(store)/customer-detail', params: { customerGuuid: item.guuid } })}
      />
    ),
    [],
  );

  return (
    <AppLayout title="Customers" rightElement={addButton}>
      <SearchBar value={search} onChangeText={setSearch} placeholder="Search by name, phone, email…" />

      <ListScaffold<LocalCustomer>
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        isThemed={false}
        listProps={{ refetch: () => undefined }}
        loaderProps={{
          isLoading: false,
          isFetching: false,
          loadingCard: () => null,
          loaderLength: 0,
        }}
        emptyState={
          error
            ? { message: "Couldn't load customers", description: error.message, icon: 'TriangleAlert' }
            : search
              ? {
                  message: 'No matches',
                  description: 'Try a different search.',
                  icon: 'Search',
                  filterActive: true,
                  onClearFilters: () => setSearch(''),
                }
              : {
                  message: 'No customers yet',
                  description: 'Tap + to add your first customer.',
                  icon: 'Users',
                }
        }
      />
    </AppLayout>
  );
}