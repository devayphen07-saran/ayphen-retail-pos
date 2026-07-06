// ─── Global augmentation ──────────────────────────────────────────────────────
// Compile-time-only reference so `styled-components/native`'s DefaultTheme is
// augmented with MobileTheme wherever this package is imported. Consumers resolve
// straight to this source file (package.json "types": "src/index.ts"), so the
// ambient declaration in ./types/styled.d.ts otherwise never enters their
// compile. A triple-slash reference (unlike a value `import`) is erased by
// TypeScript and ignored by Metro/Babel — it has zero runtime footprint, so it
// can't pull in styled-components' real module graph at bundle time.
/// <reference path="./types/styled.d.ts" />

// ─── Token objects ────────────────────────────────────────────────────────────
export { mobileThemeTokens, lightTheme, darkTheme } from "./tokens";

// ─── Token types ──────────────────────────────────────────────────────────────
export type { MobileTheme } from "./tokens";
export type {
  SizeType,
  FontSizeType,
  ColorValueType,
  ColorVariantKey,
  SemanticColorMap,
} from "./tokens";
export { ColorType } from "./tokens";




// ─── Design token building blocks (for consumers needing granular access) ─────
export {
  fontSize,
  fontFamily,
  fontWeight,
  lineHeight,
  typographyTokens,
  sizing,
  spacing,
  borderRadius,
  borderWidth,
  shadow,
  overlay,
  gradient,
  brandColorTokens,
  lightSemanticColors,
  lightColorTokens,
  lightExtendedPalette,
  darkSemanticColors,
  darkColorTokens,
  darkExtendedPalette,
} from "./tokens";

// ─── React layer ──────────────────────────────────────────────────────────────
export {
  MobileThemeProvider,
  useMobileTheme,
  useColorVariant,
} from "./ThemeProvider";

export type {
  MobileThemeContextType,
  MobileThemeProviderProps,
  ColorPlace,
  ThemePreference,
} from "./ThemeProvider";

// ─── Responsive layer ─────────────────────────────────────────────────────────
export {
  useBreakpoint,
  useResponsiveValue,
  useScaledSize,
  useScaledFont,
  breakpoints,
  deviceScale,
  fontScale,
  resolveBreakpoint,
} from "./useBreakpoint";

export type { BreakpointInfo, ResponsiveValue, Breakpoint } from "./useBreakpoint";
