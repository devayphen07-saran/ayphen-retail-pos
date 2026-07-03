import { useMemo, useState } from 'react';
import { TouchableOpacity } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  AppLayout,
  ListScaffold,
  LucideIcon,
  SearchBar,
} from '@ayphen/mobile-ui-components';

type StockFilter = 'all' | 'in-stock' | 'low-stock' | 'out-of-stock';

const FILTERS: { key: StockFilter; label: string }[] = [
  { key: 'all', label: 'All products' },
  { key: 'in-stock', label: 'In stock' },
  { key: 'low-stock', label: 'Low stock' },
  { key: 'out-of-stock', label: 'Out of stock' },
];

/**
 * Products tab — layout shell only. No product card, repository, or sync
 * wiring yet (features/products has no data layer). Search + stock-filter
 * state is local UI state; the list always renders the empty state until a
 * real product data source lands.
 */
export function ProductsScreen() {
  const { theme } = useMobileTheme();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StockFilter>('all');

  const addButton = useMemo(
    () => (
      <HeaderIconButton
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Add product"
        hitSlop={8}
      >
        <LucideIcon name="Plus" size={22} color={theme.colorPrimary} />
      </HeaderIconButton>
    ),
    [theme.colorPrimary],
  );

  return (
    <AppLayout title="Products" rightElement={addButton}>
      <SearchBar
        value={search}
        onChangeText={setSearch}
        placeholder="Search by name, SKU, barcode…"
        filterOptions={FILTERS}
        filterValue={filter}
        onFilterChange={(key) => setFilter(key as StockFilter)}
        filterTitle="Filter by stock"
      />

      <ListScaffold<never>
        data={[]}
        keyExtractor={(_item, index) => String(index)}
        renderItem={() => null}
        isThemed
        listProps={{ refetch: () => undefined }}
        loaderProps={{
          isLoading: false,
          isFetching: false,
          loadingCard: () => null,
          loaderLength: 0,
        }}
        emptyState={{
          message: 'No products yet',
          description: 'Product records will appear here once this feature ships.',
          icon: 'Package',
        }}
      />
    </AppLayout>
  );
}

const HeaderIconButton = styled(TouchableOpacity)`
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
`;
