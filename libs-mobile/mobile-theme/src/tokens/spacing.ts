import type { SizeType } from "./typography";

export const sizing: SizeType = {
  xxSmall: 4,
  xSmall: 8,
  small: 12,
  medium: 16,
  regular: 20,
  large: 24,
  xLarge: 32,
  xxLarge: 48,
  zero: 0,
  step: 4,
};

// Single source so margin and padding are always in sync.
export const spacing = {
  margin: sizing,
  padding: sizing,
} as const;

export const borderRadius: SizeType & { full: number } = {
  xxSmall: 1,
  xSmall: 2,
  small: 4,
  medium: 6,
  regular: 8,
  large: 10,
  xLarge: 12,
  xxLarge: 14,
  zero: 0,
  step: 2,
  // Pill / fully-rounded (circles, chips, pill buttons). Replaces 9999px / 999px.
  full: 9999,
};

export const borderWidth = {
  zero: 0,
  mild: 0.5,
  thin: 1,
  light: 1.5,
  medium: 3,
  bold: 4,
  // legacy aliases
  borderWidthZero: 0,
  borderWidthMild: 0.5,
  borderWidthThin: 1,
  borderWidthLight: 1.5,
  borderWidthMedium: 3,
  borderWidthBold: 4,
} as const;
