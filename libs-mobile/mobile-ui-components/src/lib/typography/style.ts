import { MobileTheme } from "@ayphen/mobile-theme";
import { TextStyle } from "react-native";
import { ColorType } from "@ayphen/mobile-theme";

// ─── Public types ────────────────────────────────────────────────────────────

export type TypographyVariant =
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "subtitle"
  | "body"
  | "caption"
  | "overline";

export type TypographyWeight =
  | "normal"
  | "light"
  | "medium"
  | "semiBold"
  | "bold";

export type TypographyType = "primary" | "secondary" | "default";

/* ---------------- VARIANTS ---------------- */
/**
 * Variant definitions set base size, weight, and font-family per role.
 *
 * IMPORTANT: variants intentionally do NOT set `color`. Color comes from the
 * `type` prop (primary/secondary/default) or the explicit `color`/`colorType`
 * props on the component. Setting color here would conflict with `type` due
 * to styled-components interpolation order.
 */
export const variantTypography: Record<
  TypographyVariant,
  (theme: MobileTheme) => TextStyle
> = {
  h1: (theme) => ({
    fontSize: theme.fontSize.h1,
    fontWeight: "700",
    fontFamily: theme.fontFamily.poppinsBold,
  }),

  h2: (theme) => ({
    fontSize: theme.fontSize.h2,
    fontWeight: "700",
    fontFamily: theme.fontFamily.poppinsBold,
  }),

  h3: (theme) => ({
    fontSize: theme.fontSize.h3,
    fontWeight: "600",
    fontFamily: theme.fontFamily.poppinsSemiBold,
  }),

  h4: (theme) => ({
    fontSize: theme.fontSize.h4,
    fontWeight: "600",
    fontFamily: theme.fontFamily.poppinsSemiBold,
  }),

  h5: (theme) => ({
    fontSize: theme.fontSize.h5,
    fontWeight: "500",
    fontFamily: theme.fontFamily.poppinsMedium,
  }),

  subtitle: (theme) => ({
    fontSize: theme.fontSize.regular,
    fontWeight: "500",
    fontFamily: theme.fontFamily.poppinsMedium,
    // NOTE: color removed — was conflicting with `type` prop. Subtitle
    // defaults to colorText via the default type; pass type="secondary"
    // for a muted look.
  }),

  body: (theme) => ({
    fontSize: theme.fontSize.small,
    fontWeight: "400",
    fontFamily: theme.fontFamily.poppinsRegular,
  }),

  caption: (theme) => ({
    fontSize: theme.fontSize.xSmall,
    fontWeight: "400",
    fontFamily: theme.fontFamily.poppinsRegular,
  }),

  overline: (theme) => ({
    fontSize: theme.fontSize.xxSmall,
    fontWeight: "400",
    fontFamily: theme.fontFamily.poppinsRegular,
  }),
};

/* ---------------- WEIGHTS ---------------- */
/**
 * Weight overrides only the font-family and fontWeight. Font-size and color
 * are owned by variant + type. `normal` is a no-op so the variant's defaults
 * stand.
 *
 * Weight values aligned with their font-family:
 *   light    → 300 + poppinsLight
 *   normal   → variant default (no override)
 *   medium   → 500 + poppinsMedium     (was incorrectly "600" before)
 *   semiBold → 600 + poppinsSemiBold
 *   bold     → 700 + poppinsBold
 */
export const weightTypography: Record<
  TypographyWeight,
  (theme: MobileTheme) => TextStyle
> = {
  light: (theme) => ({
    fontWeight: "300",
    fontFamily: theme.fontFamily.poppinsLight,
  }),

  normal: () => ({}),

  medium: (theme) => ({
    fontWeight: "500",
    fontFamily: theme.fontFamily.poppinsMedium,
  }),

  semiBold: (theme) => ({
    fontWeight: "600",
    fontFamily: theme.fontFamily.poppinsSemiBold,
  }),

  bold: (theme) => ({
    fontWeight: "700",
    fontFamily: theme.fontFamily.poppinsBold,
  }),
};

/* ---------------- TYPES (color modes) ---------------- */

export const typeTypography: Record<
  TypographyType,
  (theme: MobileTheme) => TextStyle
> = {
  primary: (theme) => ({
    color: theme.color.primary.main,
  }),

  secondary: (theme) => ({
    color: theme.color.secondary.active,
  }),

  default: (theme) => ({
    color: theme.colorText,
  }),
};

/* ---------------- COLOR HELPER ---------------- */

export const getColorFromTheme = (
  theme: MobileTheme,
  colorType?: ColorType,
): string | undefined => {
  if (!colorType) return undefined;
  return theme.color[colorType]?.main ?? theme.colorText;
};