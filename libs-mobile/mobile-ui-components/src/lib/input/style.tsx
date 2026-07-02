import { TextStyle } from "react-native";
import { NKSTheme } from "@nks/mobile-theme";

/* ---------------- Label ---------------- */

export const inputLabelStyles = (theme: NKSTheme): TextStyle => ({
  fontSize: theme.fontSize.xSmall,
  fontWeight: "600",
  marginBottom: theme.margin.xSmall,
  color: theme.colorText,
  fontFamily: theme.fontFamily.poppinsMedium,
});

/* ---------------- Input ---------------- */

export const inputStyles = (theme: NKSTheme, hasError?: boolean): TextStyle => ({
  borderWidth: hasError ? (theme.borderWidth?.light ?? 1.5) : (theme.borderWidth?.thin ?? 1),
  borderColor: hasError ? theme.colorError : theme.colorBorder,
  borderRadius: theme.borderRadius.xLarge,
  padding: theme.padding?.small ?? 12,
  fontSize: theme.fontSize.small,
  fontFamily: theme.fontFamily.poppinsRegular,
  color: theme.colorText,
});
