import { useTheme } from "styled-components/native";

/** Token → style resolver shared by both shells. Tokens only — no rgba()/hardcoded px. */
export function useSheetStyles() {
  const theme = useTheme();

  return {
    backdropColor: theme.overlay.scrim,
    sheetBackgroundColor: theme.colorBgContainer,
    sheetRadius: theme.borderRadius.xxLarge,
    handleColor: theme.colorBorder,
    headerBorderColor: theme.colorBorderSecondary,
    headerBorderWidth: theme.borderWidth.mild,
    spacing: theme.sizing,
    borderRadius: theme.borderRadius,
  };
}
