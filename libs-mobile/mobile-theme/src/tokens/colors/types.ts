/**
 * Shape of a single semantic color group (e.g. primary, danger).
 * Every color slot in the theme must satisfy this interface.
 */
export interface ColorValueType {
  bg: string;
  bgActive: string;
  bgSecondary: string;
  bgSecondaryActive: string;
  border: string;
  borderActive: string;
  active: string;
  main: string;
  onMain: string;
  text: string;
  textActive: string;
}

/**
 * All semantic color group keys used throughout the NKS design system.
 * Used instead of a `const enum` so values are available at runtime.
 */
export type ColorVariantKey =
  | "primary"
  | "secondary"
  | "danger"
  | "success"
  | "warning"
  | "orange"
  | "green"
  | "blue"
  | "violet"
  | "red"
  | "grey"
  | "default";

export const ColorType = {
  primary: "primary",
  secondary: "secondary",
  danger: "danger",
  success: "success",
  warning: "warning",
  orange: "orange",
  green: "green",
  blue: "blue",
  violet: "violet",
  red: "red",
  grey: "grey",
  default: "default",
} as const;

export type ColorType = (typeof ColorType)[keyof typeof ColorType];

export type SemanticColorMap = Record<ColorVariantKey, ColorValueType>;
