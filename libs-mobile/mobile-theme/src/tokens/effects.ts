/**
 * Visual-effect tokens: elevation shadows, overlay/scrim colors, and brand
 * gradient palettes. These are mode-independent (the brand "hero" surfaces are
 * intentionally dark in both light and dark mode), so they live in the shared
 * token layer and are spread into both `lightTheme` and `darkTheme`.
 *
 * This is the single home for the values that screens previously hardcoded:
 *   - `shadow-color: #000` + raw shadow/elevation numbers  → `theme.shadow.*`
 *   - `rgba(255,255,255,0.x)` / `rgba(0,0,0,0.x)` overlays  → `theme.overlay.*`
 *   - LinearGradient `colors={['#...','#...']}` brand ramps → `theme.gradient.*`
 */

/**
 * Pre-composed elevation presets. Each is a CSS snippet interpolated directly
 * into a styled-component template literal:
 *
 *   const Card = styled.View`
 *     ${({ theme }) => theme.shadow.md}
 *   `;
 *
 * Centralizing `shadow-color` here removes the `#000` literal from every screen.
 */
export const shadow = {
  none: "shadow-color: transparent; shadow-opacity: 0; elevation: 0;",
  sm: "shadow-color: #000; shadow-offset: 0px 1px; shadow-opacity: 0.05; shadow-radius: 2px; elevation: 1;",
  md: "shadow-color: #000; shadow-offset: 0px 2px; shadow-opacity: 0.08; shadow-radius: 8px; elevation: 3;",
  lg: "shadow-color: #000; shadow-offset: 0px 4px; shadow-opacity: 0.12; shadow-radius: 16px; elevation: 6;",
  /** Upward shadow for bottom-anchored surfaces (sheets, sticky footers, CTAs). */
  top: "shadow-color: #000; shadow-offset: 0px -6px; shadow-opacity: 0.15; shadow-radius: 20px; elevation: 16;",
} as const;

/**
 * Overlay / scrim colors. `scrim*` sit over content (modal backdrops);
 * `onDark*` are white-alpha fills used on the dark brand surfaces; `onLight*`
 * are black-alpha fills used on light surfaces.
 */
export const overlay = {
  scrim: "rgba(0, 0, 0, 0.6)",
  scrimSoft: "rgba(0, 0, 0, 0.4)",
  /** Heavy scrim for media viewers / lightboxes where content must recede fully. */
  scrimStrong: "rgba(0, 0, 0, 0.85)",
  onDark04: "rgba(255, 255, 255, 0.04)",
  onDark06: "rgba(255, 255, 255, 0.06)",
  onDark08: "rgba(255, 255, 255, 0.08)",
  onDark12: "rgba(255, 255, 255, 0.12)",
  onDark14: "rgba(255, 255, 255, 0.14)",
  onDark15: "rgba(255, 255, 255, 0.15)",
  onDark20: "rgba(255, 255, 255, 0.20)",
  onDark25: "rgba(255, 255, 255, 0.25)",
  onDark35: "rgba(255, 255, 255, 0.35)",
  onDark50: "rgba(255, 255, 255, 0.50)",
  onDark55: "rgba(255, 255, 255, 0.55)",
  onLight06: "rgba(0, 0, 0, 0.06)",
  onLight08: "rgba(0, 0, 0, 0.08)",
} as const;

/**
 * Brand gradient ramps and accent colors. Arrays feed `expo-linear-gradient`'s
 * `colors` prop; single values feed decorative orbs / single-color fills.
 */
export const gradient = {
  /** Auth / onboarding / personal-home dark hero background. */
  brandHero: ["#0D0B26", "#1A1754", "#2D2A8A"],
  /** Register-flow hero variant. */
  brandHeroAlt: ["#0A0A1A", "#111130", "#1E1B5E"],
  /** Decorative background orbs on the hero surfaces. */
  orbIndigo: "#6366F1",
  orbViolet: "#7C3AED",
  /** Primary call-to-action gradient (and its disabled / success variants). */
  cta: ["#4F46E5", "#7C3AED"],
  ctaDisabled: ["#C7D2FE", "#C7D2FE"],
  ctaSuccess: ["#10B981", "#059669"],
  /** Dashboard hero card. */
  dashboardHero: ["#3B82F6", "#6EB5FF"],
  /** Premium status card. */
  premiumCard: ["#0F172A", "#1E1B4B"],
  /** More tab's active-store identity card. */
  storeCard: ["#1E1B5E", "#3730A3"],
} as const;

/**
 * Fixed brand surface/accent colors (dark by design, mode-independent). Flat
 * tokens so they read as `theme.colorSplashBg` etc.
 */
export const brandColorTokens = {
  /** App splash / launch background. */
  colorSplashBg: "#0D0B26",
  /** Dark modal / sheet surface used by feature-locked / subscription-ended. */
  colorBrandSurface: "#0F0E1A",
  /** Lavender accent used for secondary text/icons on the dark hero. */
  colorAccentLavender: "#A5B4FC",
  /** Indigo trust/info text used on OTP verification notes. */
  colorTrustNote: "#4338CA",
} as const;

/** Fixed dimension constants that don't map to the spacing scale. */
export const componentSizing = {
  /** Standard height for full-width gradient CTA buttons. */
  ctaBtnHeight: 54,
  /** Logo / app-icon box on hero surfaces. */
  heroBrandIconSize: 36,
  /** Button size ladder — fixed heights, off the spacing scale. */
  btnHeightXsm: 26,
  btnHeightSm: 32,
  btnHeightMd: 40,
  btnHeightLg: 48,
  btnHeightXlg: 56,
} as const;