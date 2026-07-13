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
import { suppliers } from '@core/sync/db/schema';
import type { LocalSupplier } from '@core/sync/repositories/supplier.repository';
import { useActiveStoreStore } from '@store';
import { useDebouncedValue } from '../../../utils/useDebouncedValue';
import { usePrefetchStates } from '../../../components/StateSelect';
import { SupplierCard } from '../components/SupplierCard';

/**
 * Suppliers list — real local data via the sync engine's `suppliers` table
 * (drizzle-orm/expo-sqlite's `useLiveQuery` re-runs on every local write/pull).
 * Reached from the More tab (no bottom-tab slot). Search is local-only.
 */
export function SuppliersScreen() {
  const { theme } = useMobileTheme();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  // Warm the states cache before the create form is opened (even offline later).
  usePrefetchStates();
  const [search, setSearch] = useState('');
  // Local UX gating only — the create is still enforced server-side.
  const canCreateSupplier = usePermission('Supplier', 'create');

  const query = useMemo(
    () => getSyncDbForQueries().select().from(suppliers).where(eq(suppliers.storeId, storeId)),
    [storeId],
  );
  const { data, error } = useLiveQuery(query, [storeId]);
  // A delta/cold-start page upserting many rows fires expo-sqlite's per-ROW
  // change hook that many times; debounce the value to coalesce the burst.
  const debouncedData = useDebouncedValue(data, 200);
  const allSuppliers = useMemo(() => debouncedData ?? [], [debouncedData]);

  const debouncedSearch = useDebouncedValue(search, 200);
  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    if (!term) return allSuppliers;
    return allSuppliers.filter(
      (s) =>
        s.name.toLowerCase().includes(term) ||
        (s.phone?.toLowerCase().includes(term) ?? false) ||
        (s.email?.toLowerCase().includes(term) ?? false),
    );
  }, [allSuppliers, debouncedSearch]);

  const addButton = useMemo(
    () =>
      canCreateSupplier ? (
        <IconButton
          variant="ghost"
          size={36}
          iconName="Plus"
          color={theme.colorPrimary}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Add supplier"
          hitSlop={8}
          onPress={() => router.push('/(store)/supplier-create')}
        />
      ) : undefined,
    [theme.colorPrimary, canCreateSupplier],
  );

  const renderItem = useCallback(
    ({ item }: { item: LocalSupplier }) => <SupplierCard supplier={item} />,
    [],
  );

  return (
    <AppLayout title="Suppliers" rightElement={addButton}>
      <SearchBar value={search} onChangeText={setSearch} placeholder="Search by name, phone, email…" />

      <ListScaffold<LocalSupplier>
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        isThemed
        listProps={{ refetch: () => undefined }}
        loaderProps={{
          isLoading: false,
          isFetching: false,
          loadingCard: () => null,
          loaderLength: 0,
        }}
        emptyState={
          error
            ? { message: "Couldn't load suppliers", description: error.message, icon: 'TriangleAlert' }
            : search
              ? {
                  message: 'No matches',
                  description: 'Try a different search.',
                  icon: 'Search',
                  filterActive: true,
                  onClearFilters: () => setSearch(''),
                }
              : {
                  message: 'No suppliers yet',
                  description: 'Tap + to add your first supplier.',
                  icon: 'Truck',
                }
        }
      />
    </AppLayout>
  );
}