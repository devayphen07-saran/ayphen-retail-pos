import { MobileTheme } from "@ayphen/mobile-theme";

export type IconButtonVariant = "primary" | "default" | "dashed" | "secondary" | "ghost";

const primaryStyle = (theme: MobileTheme, backgroundColor?: string) => ({
  backgroundColor: backgroundColor || theme.colorPrimary,
  borderWidth: 0,
});

// Chrome-less: no background, no border — a plain tappable icon (header actions).
const ghostStyle = (theme: MobileTheme, backgroundColor?: string) => ({
  backgroundColor: backgroundColor || theme.transparent,
  borderWidth: 0,
});

const defaultStyle = (theme: MobileTheme) => ({
  backgroundColor: theme.colorBgContainer,
  borderWidth: 1,
  borderColor: theme.colorPrimary,
  borderStyle: "solid" as const,
});

const dashedStyle = (theme: MobileTheme) => ({
  backgroundColor: theme.colorBgContainer,
  borderWidth: 1,
  borderColor: theme.colorPrimary,
  borderStyle: "dashed" as const,
});

const secondaryStyle = (theme: MobileTheme) => ({
  borderColor: theme.colorBorder,
  borderWidth: 1,
  borderStyle: "solid" as const,
  backgroundColor: theme.colorBgContainer,
});

export const iconButtonVariant: Record<
  IconButtonVariant,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (theme: MobileTheme, backgroundColor?: string) => any
> = {
  primary: primaryStyle,
  default: defaultStyle,
  dashed: dashedStyle,
  secondary: secondaryStyle,
  ghost: ghostStyle,
};
