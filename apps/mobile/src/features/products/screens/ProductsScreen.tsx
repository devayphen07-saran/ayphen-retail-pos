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
import { products } from '@core/sync/db/schema';
import type { LocalProduct } from '@core/sync/repositories/product.repository';
import { useActiveStoreStore } from '@store';
import { useDebouncedValue } from '../../../utils/useDebouncedValue';
import { ProductCard } from '../components/ProductCard';

/**
 * Products tab — real local data via the sync engine's `products` table
 * (drizzle-orm/expo-sqlite's `useLiveQuery` re-runs the query on every local
 * write/pull, no manual refetch wiring needed). Search is local-only (no
 * server round trip). There is deliberately no stock-level filter here —
 * `product.stock_quantity` doesn't exist locally yet (it's a projection over
 * an inventory ledger that isn't built — POS/inventory is out of scope until
 * the backend's order/shift/stock write handlers exist), so a filter that
 * can't actually filter would be exactly the kind of stub-that-looks-real
 * this screen used to be.
 */
export function ProductsScreen() {
  const { theme } = useMobileTheme();
  const storeId = useActiveStoreStore((s) => s.storeId) ?? '';
  const [search, setSearch] = useState('');
  // Local UX gating only — the create endpoint is still enforced server-side
  // regardless of this check (see usePermission.ts / permission-check.ts).
  const canCreateProduct = usePermission('Product', 'create');

  const query = useMemo(
    () => getSyncDbForQueries().select().from(products).where(eq(products.storeId, storeId)),
    [storeId],
  );
  const { data, error } = useLiveQuery(query, [storeId]);
  // A delta/cold-start page upserting many rows fires expo-sqlite's
  // per-ROW change hook that many times (not once per transaction), so
  // useLiveQuery can re-run its SELECT and hand back a new `data` reference
  // in a rapid burst. Debouncing the value (not the query itself — the local
  // SELECT is cheap) coalesces that burst into one render instead of one per
  // row.
  const debouncedData = useDebouncedValue(data, 200);
  const allProducts = useMemo(() => debouncedData ?? [], [debouncedData]);

  const debouncedSearch = useDebouncedValue(search, 200);
  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    if (!term) return allProducts;
    return allProducts.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        (p.sku?.toLowerCase().includes(term) ?? false) ||
        (p.barcode?.toLowerCase().includes(term) ?? false),
    );
  }, [allProducts, debouncedSearch]);

  const addButton = useMemo(
    () =>
      canCreateProduct ? (
        <IconButton
          variant="ghost"
          size={36}
          iconName="Plus"
          color={theme.colorPrimary}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Add product"
          hitSlop={8}
          onPress={() => router.push('/(store)/product-create')}
        />
      ) : undefined,
    [theme.colorPrimary, canCreateProduct],
  );

  // Stable identity so FlashList row recycling isn't defeated by a fresh
  // closure each render (§5).
  const renderItem = useCallback(
    ({ item }: { item: LocalProduct }) => <ProductCard product={item} />,
    [],
  );

  return (
    <AppLayout title="Products" rightElement={addButton}>
      <SearchBar value={search} onChangeText={setSearch} placeholder="Search by name, SKU, barcode…" />

      <ListScaffold<LocalProduct>
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
            ? { message: "Couldn't load products", description: error.message, icon: 'TriangleAlert' }
            : search
              ? {
                  message: 'No matches',
                  description: 'Try a different search.',
                  icon: 'Search',
                  filterActive: true,
                  onClearFilters: () => setSearch(''),
                }
              : {
                  message: 'No products yet',
                  description: 'Tap + to add your first product.',
                  icon: 'Package',
                }
        }
      />
    </AppLayout>
  );
}
