import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, LucideIcon, Typography, useBottomSheet } from '@ayphen/mobile-ui-components';
import type { LocationResponse } from '@ayphen/api-manager';
import { LocationSelectSheet, type LocationSelectSheetProps } from './LocationSelectSheet';

// ── Locations multi-select (SelectGeneric itself is single-select-only) ─────

export interface LocationsSelectProps {
  locations: LocationResponse[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  selectedIds: string[];
  disabled: boolean;
  errorMessage: string | undefined;
  onChange: (ids: string[]) => void;
}

export function LocationsSelect({
  locations,
  loading,
  error,
  onRetry,
  selectedIds,
  disabled,
  errorMessage,
  onChange,
}: LocationsSelectProps) {
  const { theme } = useMobileTheme();
  const sheet = useBottomSheet();

  const openSheet = () => {
    sheet.open<LocationSelectSheetProps>({
      snapPoint: 'md',
      title: 'Select locations',
      closeOnBackdrop: true,
      Component: LocationSelectSheet,
      props: {
        locations,
        initialSelected: selectedIds,
        onConfirm: onChange,
        isError: error,
        onRetry,
      },
    });
  };

  const summary =
    selectedIds.length === 0
      ? 'Select locations'
      : selectedIds.length === 1
        ? (locations.find((l) => l.id === selectedIds[0])?.name ?? '1 selected')
        : `${selectedIds.length} locations selected`;

  return (
    <Column gap={4}>
      <Typography.Caption style={{ marginLeft: 3 }}>
        Locations
        <Typography.Body type="secondary" style={{ color: theme.colorRed }}>
          {' *'}
        </Typography.Body>
      </Typography.Caption>
      <SelectField
        activeOpacity={0.85}
        disabled={disabled || loading}
        style={{ opacity: disabled || loading ? 0.6 : 1 }}
        onPress={openSheet}
      >
        <Typography.Body>
          {loading
            ? 'Loading locations…'
            : error
              ? "Couldn't load locations — tap to retry"
              : summary}
        </Typography.Body>
        <LucideIcon
          name="ChevronDown"
          size={20}
          color={theme.colorTextSecondary}
        />
      </SelectField>
      {errorMessage && (
        <Typography.Caption color={theme.colorError} accessibilityRole="alert">
          {errorMessage}
        </Typography.Caption>
      )}
    </Column>
  );
}

const SelectField = styled.TouchableOpacity`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  padding: ${({ theme }) => theme.sizing.medium}px;
`;
