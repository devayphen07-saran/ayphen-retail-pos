import React from "react";
import { Platform, StyleProp, TextProps, TextStyle, Text } from "react-native";
import styled, { css } from "styled-components/native";
import { ColorType, useBreakpoint } from "@nks/mobile-theme";

import {
  variantTypography,
  weightTypography,
  typeTypography,
  TypographyVariant,
  TypographyWeight,
  TypographyType,
} from "./style";

// Re-export types so consumers can `import { TypographyVariant } from '@/components/Typography'`
export type { TypographyVariant, TypographyWeight, TypographyType };

// ─── Public props ────────────────────────────────────────────────────────────

/**
 * Font-size scale clamp. Mobile-theme can return fontScale > 1.5 on devices
 * where the user has cranked accessibility text size; we cap to avoid layout
 * breakage on small phones. Adjust if your design system has tested values.
 */
const FONT_SCALE_MIN = 0.85;
const FONT_SCALE_MAX = 1.4;

export interface TypographyProps extends Omit<TextProps, "style"> {
  variant?: TypographyVariant;
  /** Theme-keyed color (e.g., 'primary', 'secondary'). Wins over `color`. */
  colorType?: ColorType;
  /** Raw color value (hex, rgba, etc.). Used only if `colorType` is absent. */
  color?: string;
  /** Override the font weight without changing variant. */
  weight?: TypographyWeight | number;
  /** Theme color mode (primary/secondary/default). Default: 'default'. */
  type?: TypographyType;
  /** Optional children — typography placeholders may render empty. */
  children?: React.ReactNode;
  /**
   * Standard RN style prop. Accepts arrays, falsy values, nested arrays —
   * same shape as native Text's style.
   */
  style?: StyleProp<TextStyle>;
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Internal base component. Uses forwardRef so that Animated.createAnimatedComponent
 * (in Animated.tsx) can attach refs correctly. Without forwardRef, animated
 * variants would warn and refs would be lost.
 */
const BaseTypography = React.forwardRef<Text, TypographyProps>(
  (
    {
      variant = "body",
      type = "default",
      colorType,
      color,
      weight,
      children,
      ...props
    },
    ref,
  ) => {
    const { fontScale } = useBreakpoint();

    // Clamp + NaN guard: prevents font-size: NaNpx (Android crash) or
    // unusably small text on high-accessibility devices.
    const safeFontScale =
      Number.isFinite(fontScale) && fontScale > 0
        ? Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, fontScale))
        : 1;

    return (
      <StyledText
        ref={ref}
        variant={variant}
        type={type}
        weight={weight}
        color={color}
        $colorType={colorType}
        $fontScale={safeFontScale}
        // Sensible default: prevent overflow that breaks layout
        // (consumers can override via props)
        {...props}
      >
        {children}
      </StyledText>
    );
  },
);

BaseTypography.displayName = "Typography";

/* ---------------- Variant factory ---------------- */

/**
 * Creates a Typography variant component. Uses forwardRef so animated wrappers
 * propagate refs correctly.
 */
function createTypographyVariant(variant: TypographyVariant) {
  const Variant = React.forwardRef<Text, Omit<TypographyProps, "variant">>(
    (props, ref) => <BaseTypography ref={ref} variant={variant} {...props} />,
  );
  Variant.displayName = `Typography.${variant.toUpperCase()}`;
  return Variant;
}

/* ---------------- Export API ---------------- */

export const Typography = Object.assign(BaseTypography, {
  H1: createTypographyVariant("h1"),
  H2: createTypographyVariant("h2"),
  H3: createTypographyVariant("h3"),
  H4: createTypographyVariant("h4"),
  H5: createTypographyVariant("h5"),
  Subtitle: createTypographyVariant("subtitle"),
  Body: createTypographyVariant("body"),
  Caption: createTypographyVariant("caption"),
  Overline: createTypographyVariant("overline"),
});

export default Typography;

// ─── Styles ──────────────────────────────────────────────────────────────────

interface StyledTextProps {
  variant: TypographyVariant;
  weight?: TypographyWeight | number;
  color?: string;
  type?: TypographyType;
  $colorType?: ColorType;
  $fontScale: number;
}

const StyledText = styled(Text)<StyledTextProps>`
  /*
   * IMPORTANT — Android padding fix.
   *
   * Android's default Text rendering adds vertical padding around the glyph
   * box ("font padding") and clips descenders. We disable it here.
   *
   * This block is placed FIRST so that any consumer-provided
   * padding/margin via the 'style' prop (which is applied last by styled-
   * components) wins. Previously this block was at the end, silently
   * overriding any padding the caller set.
   */
  ${Platform.select({
    android: css`
      include-font-padding: false;
    `,
    default: css``,
  })}

  /* Variant styles: base size, fontWeight, fontFamily */
  ${({ variant, theme }) => variantTypography[variant](theme) as any}

  /* Weight override (numeric or named) — runs after variant so it wins */
  ${({ weight, theme }) => {
    if (weight == null) return css``;
    if (typeof weight === "number") {
      return css`
        font-weight: ${String(weight)};
      `;
    }
    return weightTypography[weight](theme) as any;
  }}

  /* Type color (primary/secondary/default) — runs before color overrides */
  ${({ type = "default", theme }) => typeTypography[type](theme) as any}

  /*
   * Final font-size with scale applied.
   *
   * We re-resolve the variant's fontSize here rather than caching it because
   * styled-components evaluates each interpolation independently. The cost
   * is one extra function call per render — negligible.
   */
  font-size: ${({ variant, theme, $fontScale }) => {
    const baseSize = variantTypography[variant](theme).fontSize as
      | number
      | undefined;
    const size = typeof baseSize === "number" ? baseSize : 14;
    const scaled = size * $fontScale;
    // Final safety: never return 0 or negative (crashes Android)
    return Math.max(8, scaled);
  }}px;

  /*
   * Color resolution order (last wins):
   *   1. variant color (intentionally not set in our variants)
   *   2. type color (primary/secondary/default)
   *   3. explicit color prop (raw value)
   *   4. colorType prop (theme key) — highest priority for theming
   */
  ${({ color }) =>
    color
      ? css`
          color: ${color};
        `
      : css``}
  ${({ $colorType, theme }) =>
    $colorType
      ? css`
          color: ${theme.color[$colorType]?.main ?? theme.colorText};
        `
      : css``}
`;