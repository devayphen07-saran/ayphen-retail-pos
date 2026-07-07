import { useState } from 'react';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { CheckBox, Column, SheetConfirmActions, Typography, useBottomSheet } from '@ayphen/mobile-ui-components';
import type { LocationResponse } from '@ayphen/api-manager';

export interface LocationSelectSheetProps {
  locations: LocationResponse[];
  initialSelected: string[];
  onConfirm: (ids: string[]) => void;
  /** True when `locations` is empty because the fetch failed, not because
   *  there genuinely are none — enables the Retry action below instead of
   *  the dead-end "No locations available" message with no way to recover
   *  short of closing this sheet and reopening the whole screen. */
  isError: boolean;
  onRetry: () => void;
}

/** Sheet content — a component reference, never a rendered element (modal-architecture-agent.md §9). */
export function LocationSelectSheet({
  locations,
  initialSelected,
  onConfirm,
  isError,
  onRetry,
}: LocationSelectSheetProps) {
  const { theme } = useMobileTheme();
  const sheet = useBottomSheet();
  const [selected, setSelected] = useState<string[]>(initialSelected);

  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  if (isError) {
    return (
      <Column
        gap={theme.sizing.medium}
        style={{ padding: theme.sizing.medium }}
      >
        <Typography.Caption type="secondary">
          Couldn't load locations. Check your connection and try again.
        </Typography.Caption>
        <SheetConfirmActions
          confirmLabel="Retry"
          cancelLabel="Cancel"
          onConfirm={() => {
            onRetry();
            sheet.close();
          }}
          onCancel={() => sheet.close()}
        />
      </Column>
    );
  }

  if (locations.length === 0) {
    return (
      <Column
        gap={theme.sizing.medium}
        style={{ padding: theme.sizing.medium }}
      >
        <Typography.Caption type="secondary">
          No locations available.
        </Typography.Caption>
        <SheetConfirmActions
          confirmLabel="Close"
          onConfirm={() => sheet.close()}
          onCancel={() => sheet.close()}
        />
      </Column>
    );
  }

  return (
    <Column gap={theme.sizing.small} style={{ padding: theme.sizing.medium }}>
      {locations.map((loc) => {
        const isSelected = selected.includes(loc.id);
        return (
          <LocationRow
            key={loc.id}
            activeOpacity={0.7}
            $selected={isSelected}
            onPress={() => toggle(loc.id)}
          >
            <Column flex={1} gap={2}>
              <Typography.Body weight="medium">{loc.name}</Typography.Body>
              {/* Every store's primary location is conventionally named
                  "Head Office" already — a badge here would just repeat the
                  name, so it's only shown for a differently-named primary. */}
              {loc.is_primary && loc.name !== 'Head Office' && (
                <Typography.Caption type="secondary">Head Office</Typography.Caption>
              )}
            </Column>
            <CheckBox value={isSelected} onValueChange={() => toggle(loc.id)} size={16} />
          </LocationRow>
        );
      })}
      <SheetConfirmActions
        confirmLabel="Done"
        cancelLabel="Cancel"
        onConfirm={() => {
          onConfirm(selected);
          sheet.close();
        }}
        onCancel={() => sheet.close()}
      />
    </Column>
  );
}

const LocationRow = styled.TouchableOpacity<{ $selected: boolean }>`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.sizing.small}px;
  background-color: ${({ theme, $selected }) =>
    $selected ? theme.color.primary.bg : theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  border-width: ${({ theme, $selected }) =>
    $selected ? theme.borderWidth.light : theme.borderWidth.thin}px;
  border-color: ${({ theme, $selected }) =>
    $selected ? theme.color.primary.main : theme.colorBorder};
  padding: ${({ theme }) => theme.sizing.medium}px;
`;
