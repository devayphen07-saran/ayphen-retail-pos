import { MobileTheme } from "@ayphen/mobile-theme";

export type ButtonVariant = "primary" | "default" | "dashed" | "text";

const primaryStyle = (theme: MobileTheme) => ({
  backgroundColor: theme.colorPrimary,
  borderWidth: 0,
});

const defaultStyle = (theme: MobileTheme) => ({
  backgroundColor: theme.colorBgContainer,
  borderWidth: 1,
  borderColor: theme.colorPrimary,
});

const dashedStyle = (theme: MobileTheme) => ({
  backgroundColor: "transparent",
  borderWidth: 1,
  borderStyle: "dashed" as const,
  borderColor: theme.colorPrimary,
});

const textStyle = (_theme: MobileTheme) => ({
  backgroundColor: "transparent",
  borderWidth: 0,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const buttonVariant: Record<ButtonVariant, (theme: MobileTheme) => any> = {
  primary: primaryStyle,
  default: defaultStyle,
  dashed: dashedStyle,
  text: textStyle,
};

const primaryTextStyle = (theme: MobileTheme) => ({
  color: theme.colorWhite,
});

const defaultTextStyle = (theme: MobileTheme) => ({
  color: theme.colorText,
});

const dashedTextStyle = (theme: MobileTheme) => ({
  color: theme.colorPrimary,
});

const textTextStyle = (theme: MobileTheme) => ({
  color: theme.colorText,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const buttonTextVariant: Record<ButtonVariant, (theme: MobileTheme) => any> = {
  primary: primaryTextStyle,
  default: defaultTextStyle,
  dashed: dashedTextStyle,
  text: textTextStyle,
};
