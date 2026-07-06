import { useMemo, useState } from 'react';
import { eq } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';
import { router } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  AppLayout,
  Column,
  IconButton,
  ListScaffold,
  SearchBar,
  Typography,
} from '@ayphen/mobile-ui-components';
import { getSyncDbForQueries } from '@core/sync/db/client';
import { products } from '@core/sync/db/schema';
import type { LocalProduct } from '@core/sync/repositories/product.repository';
import { useActiveStoreStore } from '@store';

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

  const query = useMemo(
    () => getSyncDbForQueries().select().from(products).where(eq(products.storeId, storeId)),
    [storeId],
  );
  const { data, error } = useLiveQuery(query, [storeId]);
  const allProducts = useMemo(() => data ?? [], [data]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return allProducts;
    return allProducts.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        (p.sku?.toLowerCase().includes(term) ?? false) ||
        (p.barcode?.toLowerCase().includes(term) ?? false),
    );
  }, [allProducts, search]);

  const addButton = useMemo(
    () => (
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
    ),
    [theme.colorPrimary],
  );

  return (
    <AppLayout title="Products" rightElement={addButton}>
      <SearchBar value={search} onChangeText={setSearch} placeholder="Search by name, SKU, barcode…" />

      <ListScaffold<LocalProduct>
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ProductRow product={item} />}
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

function ProductRow({ product }: { product: LocalProduct }) {
  const { theme } = useMobileTheme();
  return (
    <Column
      gap={2}
      style={{ paddingVertical: theme.sizing.small, paddingHorizontal: theme.sizing.medium }}
    >
      <Typography.Body weight="medium">{product.name}</Typography.Body>
      <Typography.Caption type="secondary">
        {product.sku ? `SKU ${product.sku} · ` : ''}
        {'₹'}
        {product.sellingPrice}
      </Typography.Caption>
    </Column>
  );
}
