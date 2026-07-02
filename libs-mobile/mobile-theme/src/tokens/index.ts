import {
  lightSemanticColors,
  lightColorTokens,
  lightExtendedPalette,
} from "./colors/light";
import {
  darkSemanticColors,
  darkColorTokens,
  darkExtendedPalette,
} from "./colors/dark";
import { typographyTokens } from "./typography";
import { sizing, spacing, borderRadius, borderWidth } from "./spacing";
import { shadow, overlay, gradient, brandColorTokens, componentSizing } from "./effects";

// ─── Assembled theme objects ──────────────────────────────────────────────────

const shared = {
  sizing,
  borderRadius,
  borderWidth,
  shadow,
  overlay,
  gradient,
  componentSizing,
  ...brandColorTokens,
  ...spacing,
  ...typographyTokens,
} as const;

export const lightTheme = {
  ...shared,
  wireframe: true,
  opacityLoading: 0.65,
  opacityImage: 1,
  zIndexBase: 0,
  zIndexPopupBase: 1000,
  color: lightSemanticColors,
  ...lightColorTokens,
  ...lightExtendedPalette,
} as const;

export const darkTheme = {
  ...shared,
  wireframe: false,
  opacityLoading: 0.8,
  opacityImage: 1,
  zIndexBase: 0,
  zIndexPopupBase: 1000,
  color: darkSemanticColors,
  ...darkColorTokens,
  ...darkExtendedPalette,
} as const;

// ─── Public token API ─────────────────────────────────────────────────────────

export const mobileThemeTokens = {
  light: lightTheme,
  dark: darkTheme,
} as const;

// ─── Public token type ────────────────────────────────────────────────────────

/**
 * Widens string literal types (produced by `as const`) to `string` so that
 * both `lightTheme` and `darkTheme` are assignable to `NKSTheme`.
 * Structured properties (sizing, borderRadius, etc.) keep their exact types.
 */
type WidenStrings<T> = {
  readonly [K in keyof T]: T[K] extends string
    ? string
    : T[K] extends boolean
      ? boolean
      : T[K] extends number
        ? number
        : T[K] extends Record<string, unknown>
          ? WidenStrings<T[K]>
          : T[K];
};

export type NKSTheme = WidenStrings<typeof lightTheme>;

// ─── Re-export building blocks for consumers that need granular access ────────

export { sizing, spacing, borderRadius, borderWidth } from "./spacing";
export { shadow, overlay, gradient, brandColorTokens, componentSizing } from "./effects";
export {
  fontSize,
  fontFamily,
  fontWeight,
  lineHeight,
  typographyTokens,
} from "./typography";
export {
  lightSemanticColors,
  lightColorTokens,
  lightExtendedPalette,
} from "./colors/light";
export {
  darkSemanticColors,
  darkColorTokens,
  darkExtendedPalette,
} from "./colors/dark";
export {
  ColorType,
  type ColorValueType,
  type ColorVariantKey,
  type SemanticColorMap,
} from "./colors/types";
export type { SizeType, FontSizeType } from "./typography";
export {
  breakpoints,
  deviceScale,
  fontScale,
  resolveBreakpoint,
} from "./breakpoints";
export type { Breakpoint } from "./breakpoints";
