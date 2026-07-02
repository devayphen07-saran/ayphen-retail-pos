export interface SizeType {
  xxSmall: number;
  xSmall: number;
  small: number;
  regular: number;
  medium: number;
  large: number;
  xLarge: number;
  xxLarge: number;
  zero: number;
  step: number;
}

export interface FontSizeType extends SizeType {
  h1: number;
  h2: number;
  h3: number;
  h4: number;
  h5: number;
}

export const fontSize: FontSizeType = {
  xxSmall: 10, // overline, helper text
  xSmall: 12, // caption
  small: 14, // small body
  regular: 16, // default body
  medium: 17, // subtitle
  large: 18, // h5
  xLarge: 20, // h4
  xxLarge: 24, // h3
  h1: 32,
  h2: 28,
  h3: 24,
  h4: 20,
  h5: 18,
  zero: 0,
  step: 2,
};

export const fontFamily = {
  poppinsRegular: "Poppins-Regular",
  poppinsBold: "Poppins-Bold",
  poppinsLight: "Poppins-Light",
  poppinsMedium: "Poppins-Medium",
  poppinsSemiBold: "Poppins-SemiBold",
  poppinsThin: "Poppins-Thin",
  poppinsItalic: "Poppins-Italic",
} as const;

export const fontWeight = {
  "100": 100,
  "200": 200,
  "300": 300,
  "400": 400,
  "500": 500,
  "600": 600,
  "700": 700,
  "800": 800,
  "900": 900,
} as const;

export const lineHeight = {
  base: 1.5714285714,
  sm: 1.6666666667,
  lg: 1.5,
  heading1: 1.2105263158,
  heading2: 1.2666666667,
  heading3: 1.3333333333,
  heading4: 1.4,
  heading5: 1.5,
} as const;

/** Flat token spread compatible with the theme object shape. */
export const typographyTokens = {
  fontFamily,
  fontSize,
  fontWeight,
  // legacy flat aliases retained for backward compat
  lineHeight: lineHeight.base,
  lineHeightSM: lineHeight.sm,
  lineHeightLG: lineHeight.lg,
  lineHeightHeading1: lineHeight.heading1,
  lineHeightHeading2: lineHeight.heading2,
  lineHeightHeading3: lineHeight.heading3,
  lineHeightHeading4: lineHeight.heading4,
  lineHeightHeading5: lineHeight.heading5,
} as const;
