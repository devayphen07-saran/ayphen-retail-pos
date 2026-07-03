import { useState } from 'react';
import {
  AppLayout,
  ListScaffold,
  SearchBar,
} from '@ayphen/mobile-ui-components';

type CategoryFilter = 'all';

const FILTERS: { key: CategoryFilter; label: string }[] = [
  { key: 'all', label: 'All categories' },
];

/**
 * POS tab — layout shell only. No product card, cart, shift, or sync wiring
 * yet (features/pos has no data layer). Search + category-filter state is
 * local UI state; the product grid always renders the empty state until a
 * real catalog data source lands.
 */
export function PosScreen() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');

  return (
    <AppLayout title="Point of Sale">
      <SearchBar
        value={search}
        onChangeText={setSearch}
        placeholder="Search by name, SKU, barcode…"
        filterOptions={FILTERS}
        filterValue={category}
        onFilterChange={(key) => setCategory(key as CategoryFilter)}
        filterTitle="Filter by category"
      />

      <ListScaffold<never>
        data={[]}
        keyExtractor={(_item, index) => String(index)}
        renderItem={() => null}
        numColumns={3}
        isThemed
        listProps={{ refetch: () => undefined }}
        loaderProps={{
          isLoading: false,
          isFetching: false,
          loadingCard: () => null,
          loaderLength: 0,
        }}
        emptyState={{
          message: 'No active products available',
          description: 'Products will appear here once the catalog is set up.',
          icon: 'PackageX',
        }}
      />
    </AppLayout>
  );
}
