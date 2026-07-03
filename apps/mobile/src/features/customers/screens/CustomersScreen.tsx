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

type CustomerFilter = 'all' | 'has-balance' | 'zero-balance';

const FILTERS: { key: CustomerFilter; label: string }[] = [
  { key: 'all', label: 'All customers' },
  { key: 'has-balance', label: 'Due balance' },
  { key: 'zero-balance', label: 'Zero balance' },
];

/**
 * Customers tab — layout shell only. No customer card, repository, or sync
 * wiring yet (features/customers has no data layer). Search + filter state is
 * local UI state; the list always renders the empty state until a real
 * customer data source lands.
 */
export function CustomersScreen() {
  const { theme } = useMobileTheme();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CustomerFilter>('all');

  const addButton = useMemo(
    () => (
      <IconBtn
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Add customer"
        hitSlop={8}
      >
        <LucideIcon name="Plus" size={22} color={theme.colorPrimary} />
      </IconBtn>
    ),
    [theme.colorPrimary],
  );

  return (
    <AppLayout title="Customers" rightElement={addButton}>
      <SearchBar
        value={search}
        onChangeText={setSearch}
        placeholder="Search by name, phone, email…"
        filterOptions={FILTERS}
        filterValue={filter}
        onFilterChange={(key) => setFilter(key as CustomerFilter)}
        filterTitle="Filter by balance"
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
          message: 'No customers yet',
          description: 'Customer records will appear here once this feature ships.',
          icon: 'Users',
        }}
      />
    </AppLayout>
  );
}

const IconBtn = styled(TouchableOpacity)`
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
`;
