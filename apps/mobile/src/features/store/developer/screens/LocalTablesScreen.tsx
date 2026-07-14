import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Alert, AppLayout, Typography } from '@ayphen/mobile-ui-components';
import styled from 'styled-components/native';
import { MenuRowList } from '@features/more';
import { getSyncDb } from '@core/sync/db/client';
import { listLocalTables, type LocalTableSummary } from '../utils/sqlite-introspection';

/**
 * Developer > Local Tables — raw SQLite table browser (menu-config.ts's
 * `developer` section, hidden from the menu in production AND __DEV__-gated
 * at the route itself — local-tables.tsx — so a deep link can't reach it
 * either). Reads `sqlite_master` directly rather than the Drizzle schema
 * exports so it also shows anything Drizzle itself creates outside the SQL
 * migrations (e.g. `__drizzle_migrations`).
 */
export function LocalTablesScreen() {
  const { theme } = useMobileTheme();
  const [tables, setTables] = useState<LocalTableSummary[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setTables(await listLocalTables(getSyncDb()));
    } catch {
      Alert.info('Error', "Couldn't read the local database.");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const totalRows = tables?.reduce((sum, t) => sum + t.rowCount, 0) ?? 0;

  return (
    <AppLayout title="Local Tables" onBack={() => router.back()}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void handleRefresh()} />
        }
        contentContainerStyle={{
          padding: theme.sizing.medium,
          // 40 has no exact token; nearest token is xxLarge (48).
          paddingBottom: theme.sizing.xxLarge,
        }}
      >
        {tables === null ? (
          <Typography.Caption type="secondary">Loading…</Typography.Caption>
        ) : (
          <>
            <SummaryCaption type="secondary">
              {tables.length} table{tables.length === 1 ? '' : 's'} · {totalRows.toLocaleString()} rows total
            </SummaryCaption>
            <MenuRowList
              items={tables.map((table) => ({
                key: table.name,
                title: table.name,
                description: `${table.rowCount.toLocaleString()} row${table.rowCount === 1 ? '' : 's'}`,
                iconName: 'Table2',
                iconColor: 'teal',
                onPress: () =>
                  router.push({
                    pathname: '/(store)/local-table-detail',
                    params: { table: table.name },
                  }),
              }))}
            />
          </>
        )}
      </ScrollView>
    </AppLayout>
  );
}

const SummaryCaption = styled(Typography.Caption)`
  margin-bottom: ${({ theme }) => theme.sizing.small}px;
`;