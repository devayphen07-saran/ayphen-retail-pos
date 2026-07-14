import React, { ReactElement, useCallback, useEffect, useMemo, useRef } from "react";
import { ViewStyle } from "react-native";

import {
  SelectGenericContainer,
  SelectLabelText,
  SelectTouchable,
  Separator,
} from "./styles";
import styled, { useTheme } from "styled-components/native";
import { useBreakpoint } from "@ayphen/mobile-theme";
import { Typography } from "../typography";
import { LucideIcon } from "../lucide-icon";
import { ThemedFlatList } from "../flat-list-scaffold/ThemedFlatList";
import { NoDataContainer } from "../flat-list-scaffold/NoDataContainer";
import { SelectSkeleton } from "./select-skeleton";
import { useBottomSheet } from "../BottomSheet";

type valueType = string | number | undefined | null;

export interface SelectProps<T> {
  options: T[];
  value?: valueType;
  onChange: (value: T | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
  style?: ViewStyle;
  multiple?: boolean;
  Header?: React.ReactNode;
  renderItem: (value: T, onSelectItem: (value: T) => void, isSelected: boolean) => ReactElement;
  keyExtractor?: ((item: T, index: number) => string) | undefined;
  valueKey: keyof T;
  label?: string;
  required?: boolean;
  displayRenderer: (value: T | undefined) => ReactElement;
  errorMessage?: string;
  noDataMessage: string;
  loadingRender?: React.ReactElement;
  loading?: boolean;
  /** True when `noDataMessage` reflects a failed fetch, not a genuine empty
   *  list — enables the sheet's Retry action. Without this, a load failure
   *  had no recovery short of closing and reopening the whole sheet. */
  isError?: boolean;
  onRetry?: () => void;
}

interface SelectSheetContentProps<T> {
  options: T[];
  valueKey: keyof T;
  selectedValue: T | undefined;
  onSelect: (item: T) => void;
  renderItem: SelectProps<T>["renderItem"];
  keyExtractor?: SelectProps<T>["keyExtractor"];
  loading: boolean;
  loadingRender: React.ReactElement;
  noDataMessage: string;
  Header?: React.ReactNode;
  isError?: boolean;
  onRetry?: () => void;
}

/** Sheet content — a component reference, never a rendered element (modal-architecture-agent.md §9). */
function SelectSheetContent<T>({
  options,
  valueKey,
  selectedValue,
  onSelect,
  renderItem,
  keyExtractor,
  loading,
  loadingRender,
  noDataMessage,
  Header,
  isError,
  onRetry,
}: SelectSheetContentProps<T>) {
  return (
    <>
      {Header}
      {loading && loadingRender ? (
        loadingRender
      ) : !options || options.length === 0 ? (
        <NoDataContainer
          message={noDataMessage}
          iconName={isError ? "CircleAlert" : undefined}
          buttonProps={
            isError && onRetry
              ? { buttonText: "Retry", onPress: onRetry, variant: "primary" }
              : undefined
          }
        />
      ) : (
        <ThemedFlatList
          data={options}
          keyExtractor={keyExtractor}
          scrollEnabled={true}
          renderItem={({ item }) =>
            renderItem(
              item,
              (i) => {
                const _item = item as { disabled?: boolean; isHidden?: boolean };
                if (!_item.disabled && !_item.isHidden) onSelect(i);
              },
              selectedValue?.[valueKey] === item?.[valueKey]
            )
          }
          ItemSeparatorComponent={() => <Separator />}
          loading={false}
        />
      )}
    </>
  );
}

export function SelectGeneric<T>({
  options,
  onChange,
  disabled = false,
  style,
  renderItem,
  valueKey,
  value,
  keyExtractor,
  displayRenderer,
  label,
  required,
  errorMessage,
  noDataMessage,
  loading = false,
  Header,
  loadingRender = <SelectSkeleton />,
  isError,
  onRetry,
}: SelectProps<T>) {
  const theme = useTheme();
  const { scale, fontScale } = useBreakpoint();
  const chevronSize = Math.round(22 * scale);
  const sheet = useBottomSheet();
  const isMineOpenRef = useRef(false);

  const selectedValue = useMemo(() => {
    return options.find((item) => item?.[valueKey] === value);
  }, [value, options, valueKey]);

  const buildSheetProps = useCallback(
    (): SelectSheetContentProps<T> => ({
      options,
      valueKey,
      selectedValue,
      onSelect: (item) => {
        isMineOpenRef.current = false;
        onChange(item);
        sheet.close();
      },
      renderItem,
      keyExtractor,
      loading,
      loadingRender,
      noDataMessage,
      Header,
      isError,
      onRetry,
    }),
    [options, valueKey, selectedValue, onChange, sheet, renderItem, keyExtractor, loading, loadingRender, noDataMessage, Header, isError, onRetry]
  );

  const openSheet = () => {
    isMineOpenRef.current = true;
    sheet.open<SelectSheetContentProps<T>>({
      snapPoint: "md",
      title: label,
      closeOnBackdrop: true,
      Component: SelectSheetContent,
      props: buildSheetProps(),
      onClose: () => {
        isMineOpenRef.current = false;
      },
    });
  };

  // `sheet.open()` snapshots props once (modal-architecture-agent.md §9), but
  // this select's options/loading come from an async query that can resolve
  // *after* the sheet is already open — without this, an open sheet gets
  // stuck showing the loading skeleton until closed and reopened.
  useEffect(() => {
    if (!isMineOpenRef.current) return;
    sheet.updateConfig({ props: buildSheetProps() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, loading, selectedValue, noDataMessage, isError]);

  return (
    <SelectGenericContainer style={style}>
      {label && (
        <LabelCaption>
          {label}
          {required && <RequiredMark type="secondary">{" *"}</RequiredMark>}
        </LabelCaption>
      )}

      <SelectTouchable
        onPress={() => !disabled && openSheet()}
        activeOpacity={0.85}
        disabled={disabled}
        $hasError={!!errorMessage}
        $scale={scale}
        $disabled={disabled}
      >
        <SelectLabelText $fontScale={fontScale}>{displayRenderer(selectedValue)}</SelectLabelText>
        {!selectedValue && (
          <LucideIcon name="ChevronDown" size={chevronSize} color={theme.colorTextSecondary} />
        )}

        {selectedValue && !disabled && (
          <LucideIcon
            name="X"
            size={chevronSize}
            color={theme.colorTextSecondary}
            onPress={() => {
              onChange(undefined);
            }}
          />
        )}
      </SelectTouchable>
      {errorMessage && (
        <ErrorCaption type="secondary">* {errorMessage}</ErrorCaption>
      )}
    </SelectGenericContainer>
  );
}

export default SelectGeneric;

// ─── Styles ─────────────────────────────────────────────────────────────────

const LabelCaption = styled(Typography.Caption)`
  padding-bottom: ${({ theme }) => theme.sizing.xxSmall}px;
  margin-left: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const RequiredMark = styled(Typography.Body)`
  color: ${({ theme }) => theme.colorRed};
`;

const ErrorCaption = styled(Typography.Caption)`
  color: ${({ theme }) => theme.colorRed};
  margin-left: ${({ theme }) => theme.sizing.xxSmall}px;
`;
