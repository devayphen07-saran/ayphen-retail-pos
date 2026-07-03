import { NKSTheme } from "@ayphen/mobile-theme";

export type ButtonVariant = "primary" | "default" | "dashed" | "text";

const primaryStyle = (theme: NKSTheme) => ({
  backgroundColor: theme.colorPrimary,
  borderWidth: 0,
});

const defaultStyle = (theme: NKSTheme) => ({
  backgroundColor: theme.colorBgContainer,
  borderWidth: 1,
  borderColor: theme.colorPrimary,
});

const dashedStyle = (theme: NKSTheme) => ({
  backgroundColor: "transparent",
  borderWidth: 1,
  borderStyle: "dashed" as const,
  borderColor: theme.colorPrimary,
});

const textStyle = (_theme: NKSTheme) => ({
  backgroundColor: "transparent",
  borderWidth: 0,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const buttonVariant: Record<ButtonVariant, (theme: NKSTheme) => any> = {
  primary: primaryStyle,
  default: defaultStyle,
  dashed: dashedStyle,
  text: textStyle,
};

const primaryTextStyle = (theme: NKSTheme) => ({
  color: theme.colorWhite,
});

const defaultTextStyle = (theme: NKSTheme) => ({
  color: theme.colorText,
});

const dashedTextStyle = (theme: NKSTheme) => ({
  color: theme.colorPrimary,
});

const textTextStyle = (theme: NKSTheme) => ({
  color: theme.colorText,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const buttonTextVariant: Record<ButtonVariant, (theme: NKSTheme) => any> = {
  primary: primaryTextStyle,
  default: defaultTextStyle,
  dashed: dashedTextStyle,
  text: textTextStyle,
};
