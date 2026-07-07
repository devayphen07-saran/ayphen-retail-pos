import { useCallback, useMemo, useState } from 'react';
import { ScrollView, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Alert, AppLayout, Column, SearchInput, Typography } from '@ayphen/mobile-ui-components';
import { getSyncDb } from '@core/sync/db/client';
import {
  getLocalTableColumns,
  getLocalTableRowCount,
  getLocalTableRows,
  LOCAL_TABLE_ROW_LIMIT,
  type LocalTableColumn,
} from '../utils/sqlite-introspection';

type Params = { table: string };

const MIN_COL_WIDTH = 90;
const MAX_COL_WIDTH = 220;
const CHAR_WIDTH = 7.5;

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  return String(value);
}

/**
 * Developer > Local Tables > <table> — raw row/column browser for one
 * SQLite table. No pagination beyond LOCAL_TABLE_ROW_LIMIT (this is a debug
 * viewer, not a production data browser); a tap on any cell shows its full,
 * untruncated value since payload/JSON columns routinely overflow a cell.
 */
export function LocalTableDetailScreen() {
  const { theme } = useMobileTheme();
  const { table } = useLocalSearchParams<Params>();
  const [columns, setColumns] = useState<LocalTableColumn[] | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    if (!table) return;
    try {
      const db = getSyncDb();
      const [cols, tableRows, count] = await Promise.all([
        getLocalTableColumns(db, table),
        getLocalTableRows(db, table),
        getLocalTableRowCount(db, table),
      ]);
      setColumns(cols);
      setRows(tableRows);
      setTotalCount(count);
    } catch {
      Alert.info('Error', `Couldn't read the "${table}" table.`);
    }
  }, [table]);

  useFocusEffect(
    useCallback(() => {
      void load();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [table]),
  );

  const filteredRows = useMemo(() => {
    if (!rows) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      Object.values(row).some((value) => formatCell(value).toLowerCase().includes(needle)),
    );
  }, [rows, search]);

  const colWidths = useMemo(() => {
    const widths: Record<string, number> = {};
    if (!columns || !rows) return widths;
    for (const col of columns) {
      let maxLen = col.name.length;
      for (const row of rows) {
        maxLen = Math.max(maxLen, formatCell(row[col.name]).length);
      }
      widths[col.name] = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, Math.round(maxLen * CHAR_WIDTH)));
    }
    return widths;
  }, [columns, rows]);

  const showCell = (columnName: string, value: unknown) => {
    Alert.info(columnName, formatCell(value));
  };

  return (
    <AppLayout title={table ?? 'Table'} onBack={() => router.back()}>
      <Column flex={1} padding="medium" gap="small">
        {/* SearchInput's wrapper has flex-grow: 1 (meant to fill width in a
            Row); as a direct child of this vertical Column it would instead
            grow to fill height and split the screen's leftover space with
            GridBorder below. A plain View with no flex has nothing to grow
            into, so SearchInput settles at its own fixed height. */}
        <View>
          <SearchInput value={search} onChange={setSearch} placeholder="Filter rows..." />
        </View>

        {rows !== null && (
          <Typography.Caption type="secondary">
            {totalCount > LOCAL_TABLE_ROW_LIMIT
              ? `Showing ${LOCAL_TABLE_ROW_LIMIT.toLocaleString()} of ${totalCount.toLocaleString()} rows`
              : `${totalCount.toLocaleString()} row${totalCount === 1 ? '' : 's'}`}
            {search.trim() ? ` · ${filteredRows.length} matching` : ''}
          </Typography.Caption>
        )}

        {columns === null || rows === null ? (
          <Typography.Caption type="secondary">Loading…</Typography.Caption>
        ) : columns.length === 0 ? (
          <Typography.Body>This table doesn&apos;t exist.</Typography.Body>
        ) : (
          <GridBorder>
            <ScrollView horizontal showsHorizontalScrollIndicator style={{ flex: 1 }}>
              <View style={{ flex: 1 }}>
                <HeaderRow>
                  {columns.map((col) => (
                    <HeaderCell key={col.name} style={{ width: colWidths[col.name] }}>
                      <Typography.Caption weight="semiBold" numberOfLines={1}>
                        {col.name}
                      </Typography.Caption>
                    </HeaderCell>
                  ))}
                </HeaderRow>
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
                  {filteredRows.map((row, i) => (
                    <DataRow key={i} $striped={i % 2 === 1}>
                      {columns.map((col) => (
                        <DataCell
                          key={col.name}
                          style={{ width: colWidths[col.name] }}
                          onPress={() => showCell(col.name, row[col.name])}
                          activeOpacity={0.6}
                        >
                          <Typography.Caption
                            numberOfLines={1}
                            color={row[col.name] === null ? theme.colorTextTertiary : theme.colorText}
                          >
                            {formatCell(row[col.name])}
                          </Typography.Caption>
                        </DataCell>
                      ))}
                    </DataRow>
                  ))}
                  {filteredRows.length === 0 && (
                    <View style={{ padding: theme.sizing.medium }}>
                      <Typography.Caption type="secondary">No matching rows.</Typography.Caption>
                    </View>
                  )}
                </ScrollView>
              </View>
            </ScrollView>
          </GridBorder>
        )}
      </Column>
    </AppLayout>
  );
}

const GridBorder = styled(View)`
  flex: 1;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  overflow: hidden;
`;

const HeaderRow = styled(View)`
  flex-direction: row;
  background-color: ${({ theme }) => theme.colorBgLayout};
  border-bottom-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-bottom-color: ${({ theme }) => theme.colorBorder};
`;

const HeaderCell = styled(View)`
  padding: 8px 10px;
  border-right-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-right-color: ${({ theme }) => theme.colorBorderSecondary};
`;

const DataRow = styled(View)<{ $striped: boolean }>`
  flex-direction: row;
  background-color: ${({ theme, $striped }) => ($striped ? theme.colorBgLayout : theme.colorBgContainer)};
  border-bottom-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-bottom-color: ${({ theme }) => theme.colorBorderSecondary};
`;

const DataCell = styled(TouchableOpacity)`
  padding: 8px 10px;
  border-right-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-right-color: ${({ theme }) => theme.colorBorderSecondary};
`;
