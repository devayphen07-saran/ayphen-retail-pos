import { NKSTheme } from "@nks/mobile-theme";

export type IconButtonVariant = "primary" | "default" | "dashed" | "secondary";

const primaryStyle = (theme: NKSTheme, backgroundColor?: string) => ({
  backgroundColor: backgroundColor || theme.colorPrimary,
  borderWidth: 0,
});

const defaultStyle = (theme: NKSTheme) => ({
  backgroundColor: theme.colorBgContainer,
  borderWidth: 1,
  borderColor: theme.colorPrimary,
  borderStyle: "solid" as const,
});

const dashedStyle = (theme: NKSTheme) => ({
  backgroundColor: theme.colorBgContainer,
  borderWidth: 1,
  borderColor: theme.colorPrimary,
  borderStyle: "dashed" as const,
});

const secondaryStyle = (theme: NKSTheme) => ({
  borderColor: theme.colorBorder,
  borderWidth: 1,
  borderStyle: "solid" as const,
  backgroundColor: theme.colorBgContainer,
});

export const iconButtonVariant: Record<
  IconButtonVariant,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (theme: NKSTheme, backgroundColor?: string) => any
> = {
  primary: primaryStyle,
  default: defaultStyle,
  dashed: dashedStyle,
  secondary: secondaryStyle,
};
