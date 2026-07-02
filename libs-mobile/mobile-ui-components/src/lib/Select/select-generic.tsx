import React, { ReactElement, useMemo } from "react";
import { Modal, ViewStyle } from "react-native";

import {
  SelectAnimatedSheetContainer,
  SelectBackdrop,
  SelectGenericContainer,
  SelectLabelText,
  SelectSheetBar,
  SelectTouchable,
  Separator,
} from "./styles";
import { useSelectMobile } from "./hooks";
import { Typography } from "../typography";
import { LucideIcon } from "../lucide-icon";
import { useTheme } from "styled-components/native";
import { useBreakpoint } from "@nks/mobile-theme";
import { ThemedFlatList } from "../flat-list-scaffold/ThemedFlatList";
import { NoDataContainer } from "../flat-list-scaffold/NoDataContainer";
import { SkeletonLoader } from "../SkeletonLoader";

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
  loadingRender = <SkeletonLoader />,
}: SelectProps<T>) {
  const theme = useTheme();
  const { scale, fontScale } = useBreakpoint();
  const chevronSize = Math.round(22 * scale);

  const selectedValue = useMemo(() => {
    return options.find((item) => item?.[valueKey] === value);
  }, [value, options, valueKey]);

  const { translateY, showing, setVisible } = useSelectMobile();

  return (
    <SelectGenericContainer style={style}>
      {label && (
        <Typography.Caption style={{ paddingBottom: 4, marginLeft: 3 }}>
          {label}
          {required && (
            <Typography.Body type="secondary" style={{ color: theme.colorRed }}>
              {" *"}
            </Typography.Body>
          )}
        </Typography.Caption>
      )}

      <SelectTouchable
        onPress={() => !disabled && setVisible(true)}
        activeOpacity={0.85}
        disabled={disabled}
        $hasError={!!errorMessage}
        $scale={scale}
        style={{ opacity: disabled ? 0.6 : 1 }}
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
        <Typography.Caption type="secondary" style={{ color: theme.colorRed, marginLeft: 3 }}>
          * {errorMessage}
        </Typography.Caption>
      )}

      <Modal
        visible={showing}
        transparent
        animationType="none"
        onRequestClose={() => setVisible(false)}
      >
        <SelectBackdrop onPress={() => setVisible(false)} />
        <SelectAnimatedSheetContainer style={{ transform: [{ translateY }] }}>
          <SelectSheetBar />
          {Header}
          {loading && loadingRender ? (
            loadingRender
          ) : !options || options.length === 0 ? (
            <NoDataContainer message={noDataMessage} />
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
                    if (!_item.disabled && !_item.isHidden) {
                      onChange(i);
                      setVisible(false);
                    }
                  },
                  selectedValue?.[valueKey] === item?.[valueKey]
                )
              }
              ItemSeparatorComponent={() => <Separator />}
              loading={false}
            />
          )}
        </SelectAnimatedSheetContainer>
      </Modal>
    </SelectGenericContainer>
  );
}

export default SelectGeneric;
