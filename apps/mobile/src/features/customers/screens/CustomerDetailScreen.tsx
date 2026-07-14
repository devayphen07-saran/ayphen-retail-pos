import { useCallback, useMemo, useState } from 'react';
import { desc, eq } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';
import { router } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  AppLayout,
  Avatar,
  Column,
  ListScaffold,
  MetricCard,
  Row,
  SegmentedTabs,
  Button,
  Tag,
  Typography,
  formatMinorUnits,
} from '@ayphen/mobile-ui-components';
import { usePermission } from '@core/auth/usePermission';
import { getSyncDbForQueries } from '@core/sync/db/client';
import { customers, customerLedgerEvents } from '@core/sync/db/schema';
import type { LocalCustomerLedgerEvent } from '@core/sync/repositories/customer-ledger-event.repository';
import { CustomerLedgerRowCard } from '../components/CustomerLedgerRowCard';
import { computeOutstandingPaise, creditLimitPaise } from '../utils/outstanding';

type FilterKey = 'all' | 'credit_sale' | 'settlement';

/** Payment/credit_note both settle down what's owed — grouped as one filter
 *  tab, mirroring AccountDetailScreen's All/In/Out shape for the same
 *  "one book, two directions" statement pattern. `adjustment` has no
 *  creation path yet (outstanding.ts), so it has no dedicated tab. */
function matchesFilter(event: LocalCustomerLedgerEvent, filter: FilterKey): boolean {
  if (filter === 'all') return true;
  if (filter === 'credit_sale') return event.kind === 'credit_sale';
  return event.kind === 'payment' || event.kind === 'credit_note';
}

/** A credit customer's outstanding balance + statement (docs/prd/accounts-and-ledger.md F5). */
export function CustomerDetailScreen({ customerGuuid }: { customerGuuid: string }) {
  const { theme } = useMobileTheme();
  const canCollect = usePermission('Customer', 'create');
  const [filter, setFilter] = useState<FilterKey>('all');

  const customerQuery = useMemo(
    () => getSyncDbForQueries().select().from(customers).where(eq(customers.guuid, customerGuuid)),
    [customerGuuid],
  );
  const { data: customerRows } = useLiveQuery(customerQuery, [customerGuuid]);
  const customer = customerRows?.[0];

  const ledgerQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select()
        .from(customerLedgerEvents)
        .where(eq(customerLedgerEvents.customerFk, customer?.id ?? ''))
        .orderBy(desc(customerLedgerEvents.modifiedAt)),
    [customer?.id],
  );
  const { data: ledgerRows, error: ledgerError } = useLiveQuery(ledgerQuery, [customer?.id]);
  const events = ledgerRows ?? [];
  const outstandingPaise = useMemo(() => computeOutstandingPaise(events), [events]);
  const limitPaise = creditLimitPaise(customer?.creditLimit);
  const hasFlagged = useMemo(() => events.some((e) => e.flagged), [events]);

  const filteredEvents = useMemo(() => events.filter((e) => matchesFilter(e, filter)), [events, filter]);

  const subtitle = [customer?.phone, customer?.email].filter(Boolean).join(' · ');
  const initials = (customer?.name ?? '?').trim().slice(0, 2).toUpperCase();

  const renderItem = useCallback(({ item }: { item: LocalCustomerLedgerEvent }) => <CustomerLedgerRowCard event={item} />, []);

  return (
    <AppLayout title={customer?.name ?? 'Customer'} onBack={() => router.back()}>
      <ScreenPad gap={theme.sizing.medium}>
        <Row align="center" gap="small">
          <Avatar initials={initials} size={56} shape="circle" />
          <Column flex={1} gap={theme.sizing.xxSmall}>
            <Typography.Subtitle weight="bold" numberOfLines={1}>
              {customer?.name ?? 'Customer'}
            </Typography.Subtitle>
            <Typography.Caption type="secondary" numberOfLines={1}>
              {subtitle || 'No contact details'}
            </Typography.Caption>
          </Column>
          {hasFlagged ? <Tag label="Needs review" variant="warning" size="xsm" /> : null}
        </Row>

        <Row gap="small">
          <MetricCard
            label="Outstanding"
            value={formatMinorUnits(outstandingPaise, { currency: 'INR' })}
            valueColor={outstandingPaise > 0 ? theme.colorWarning : theme.colorText}
            iconName="Receipt"
            flex={1}
          />
          <MetricCard
            label="Credit limit"
            value={limitPaise > 0 ? formatMinorUnits(limitPaise, { currency: 'INR' }) : 'No limit'}
            iconName="ShieldCheck"
            flex={1}
          />
        </Row>

        {canCollect && outstandingPaise > 0 && customer ? (
          <Button
            iconName="HandCoins"
            label="Collect payment"
            onPress={() =>
              router.push({
                pathname: '/(store)/collect-payment',
                params: { customerId: customer.id, customerGuuid: customer.guuid, customerName: customer.name },
              })
            }
          />
        ) : null}

        <Typography.Caption type="secondary" weight="medium">
          Statement
        </Typography.Caption>
      </ScreenPad>

      <TabsWrap>
        <SegmentedTabs
          items={[
            { key: 'all', label: 'All' },
            { key: 'credit_sale', label: 'Credit Sales' },
            { key: 'settlement', label: 'Settlements' },
          ]}
          selectedKey={filter}
          onChange={(key) => setFilter(key as FilterKey)}
          size="small"
        />
      </TabsWrap>

      <ListScaffold<LocalCustomerLedgerEvent>
        data={filteredEvents}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        isThemed
        listProps={{ refetch: () => undefined }}
        loaderProps={{ isLoading: false, isFetching: false, loadingCard: () => null, loaderLength: 0 }}
        emptyState={
          ledgerError
            ? { message: "Couldn't load statement", description: ledgerError.message, icon: 'TriangleAlert' }
            : filter !== 'all'
              ? {
                  message: 'No matching activity',
                  description: 'Try a different filter.',
                  icon: 'Filter',
                  filterActive: true,
                  onClearFilters: () => setFilter('all'),
                }
              : {
                  message: 'No credit activity yet',
                  description: 'Sales made on credit and payments collected will show up here.',
                  icon: 'Receipt',
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

const TabsWrap = styled(Row)`
  margin-horizontal: ${({ theme }) => theme.sizing.medium}px;
`;
