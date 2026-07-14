import React from "react";
import { ViewStyle } from "react-native";
import styled from "styled-components/native";
import { Typography } from "../typography";
import { useBreakpoint, useMobileTheme } from "@ayphen/mobile-theme";

export type SegmentedTabItem = {
  key: string;
  label: string;
  iconElement?: React.ReactNode;
  disabled?: boolean;
};

export type SegmentedTabSize = "xSmall" | "small" | "medium" | "large";

export type SegmentedTabsProps = {
  items: SegmentedTabItem[];
  selectedKey?: string;
  onChange: (key: string) => void;
  style?: ViewStyle;
  size?: SegmentedTabSize;
  disabled?: boolean;
  fullWidth?: boolean;
  showBottomLine?: boolean;
};

export function SegmentedTabs({
  items,
  selectedKey,
  onChange,
  style,
  size = "medium",
  disabled = false,
  fullWidth = true,
  showBottomLine = false,
}: SegmentedTabsProps) {
  const { scale, fontScale } = useBreakpoint();
  const { theme } = useMobileTheme();
  const fontSizeMap: Record<SegmentedTabSize, number> = {
    xSmall: theme.fontSize.xSmall,
    small: theme.fontSize.xSmall,
    medium: theme.fontSize.small,
    large: theme.fontSize.regular,
  };
  return (
    <Container
      style={style}
      accessibilityRole="tablist"
      $fullWidth={fullWidth}
      $showBottomLine={showBottomLine}
    >
      {items.map((item) => {
        const selected = item.key === selectedKey;
        const isDisabled = disabled || item.disabled;

        return (
          <TabButton
            key={item.key}
            accessibilityRole="tab"
            accessibilityState={{ selected, disabled: isDisabled }}
            onPress={() => !isDisabled && onChange(item.key)}
            activeOpacity={0.85}
            disabled={isDisabled}
            $fullWidth={fullWidth}
          >
            <Inner
              $selected={selected}
              $size={size}
              $scale={scale}
              $disabled={isDisabled}
              $showBottomLine={showBottomLine}
            >
              {item.iconElement && (
                <IconWrap $selected={selected} $disabled={isDisabled}>
                  {item.iconElement}
                </IconWrap>
              )}

              <TabLabel
                weight="semiBold"
                $opacity={isDisabled ? 0.5 : 1}
                $fontSize={fontSizeMap[size] * fontScale}
              >
                {item.label}
              </TabLabel>
            </Inner>

            {showBottomLine && selected && <BottomLine />}
          </TabButton>
        );
      })}
    </Container>
  );
}

/* ---------------------------------- */
/* Styled components                   */
/* ---------------------------------- */

const Container = styled.View<{
  $fullWidth?: boolean;
  $showBottomLine?: boolean;
}>`
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  width: ${({ $fullWidth }) => ($fullWidth ? "100%" : "auto")};
  background-color: ${({ theme, $showBottomLine }) =>
    !$showBottomLine ? theme.colorBgLayout : "transparent"};
  border-bottom-width: ${({ theme, $showBottomLine }) =>
    $showBottomLine ? theme.borderWidth.thin : 0}px;
  border-bottom-color: ${({ theme, $showBottomLine }) =>
    $showBottomLine ? theme.colorBorder : "transparent"};
  border-radius: ${({ theme, $showBottomLine }) =>
    !$showBottomLine ? theme.borderRadius.large : 0}px;
  padding: ${({ theme, $showBottomLine }) =>
    !$showBottomLine ? theme.sizing.xxSmall : 0}px;
`;

const TabButton = styled.TouchableOpacity<{
  $fullWidth?: boolean;
}>`
  flex: ${({ $fullWidth }) => ($fullWidth ? 1 : 0)};
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
`;

const paddingMap = (theme: import("styled-components/native").DefaultTheme) => ({
  xSmall: theme.componentSizing.segmentedTabsPaddingXSmall,
  small: theme.componentSizing.segmentedTabsPaddingSmall,
  medium: theme.componentSizing.segmentedTabsPaddingMedium,
  large: theme.sizing.small,
});

const Inner = styled.View<{
  $selected: boolean;
  $size: SegmentedTabSize;
  $scale: number;
  $disabled?: boolean;
  $showBottomLine?: boolean;
}>`
  flex-direction: row;
  align-items: center;
  justify-content: center;
  padding-top: ${({ $size, $scale, theme }) => paddingMap(theme)[$size] * $scale}px;
  padding-bottom: ${({ $size, $scale, theme }) => paddingMap(theme)[$size] * $scale}px;
  padding-left: ${({ $size, $scale, theme }) =>
    (paddingMap(theme)[$size] + theme.componentSizing.segmentedTabsPaddingHorizontalOffset) *
    $scale}px;
  padding-right: ${({ $size, $scale, theme }) =>
    (paddingMap(theme)[$size] + theme.componentSizing.segmentedTabsPaddingHorizontalOffset) *
    $scale}px;
  border-radius: ${({ theme, $showBottomLine }) =>
    $showBottomLine ? 0 : theme.borderRadius.medium}px;
  overflow: hidden;
  background-color: ${({ theme, $showBottomLine, $selected, $disabled }) =>
    !$showBottomLine && $selected && !$disabled
      ? theme.colorBgContainer
      : "transparent"};
  opacity: ${({ $disabled }) => ($disabled ? 0.5 : 1)};

  ${({ theme, $selected, $disabled, $showBottomLine }) =>
    $selected && !$disabled && !$showBottomLine ? theme.shadow.sm : ""}
`;

const TabLabel = styled(Typography.Caption)<{
  $opacity: number;
  $fontSize: number;
}>`
  opacity: ${({ $opacity }) => $opacity};
  font-size: ${({ $fontSize }) => $fontSize}px;
`;

const IconWrap = styled.View<{ $selected: boolean; $disabled?: boolean }>`
  opacity: ${({ $selected, $disabled }) =>
    $disabled ? 0.5 : $selected ? 1 : 0.7};
`;

const BottomLine = styled.View`
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: ${({ theme }) => theme.borderWidth.light}px;
  background-color: ${({ theme }) => theme.colorPrimary};
  border-radius: ${({ theme }) => theme.borderRadius.xSmall}px;
`;

export default SegmentedTabs;
