import type { ColorValueType, SemanticColorMap } from "./types";

// ─── Brand decision ───────────────────────────────────────────────────────────
// Primary brand: Deep Navy #1E3A8A (light mode) / #60A5FA (dark mode)
// Dark mode uses Blue 400 (#60A5FA) as the primary interactive color because
// #1E3A8A is too dark to be readable on dark surfaces — it blends into the bg.
// The brand identity is maintained via the #1E3A8A icon container backgrounds
// and the store card gradient (#1E3A8A → #2563EB).
// Surfaces: colorBgPage #0F172A (slate-900), colorBgContainer #1E293B (slate-800)
// Semantic colors (success/error/warning) unchanged from light mode intent,
// but use brighter stops for readability on dark backgrounds.

// ─── Semantic color groups ────────────────────────────────────────────────────

const primary: ColorValueType = {
  bg:                "#1E3A8A",  // dark mode icon/avatar container bg — brand navy
  bgActive:          "#1E40AF",  // slightly lighter — hover/active container
  bgSecondary:       "#0F172A",  // page background — slate-900
  bgSecondaryActive: "#1E293B",  // surface hover — slate-800
  border:            "#2563EB",  // visible border on dark — mid blue
  borderActive:      "#3B82F6",  // hover border — brighter blue
  active:            "#60A5FA",  // interactive color on dark — Blue 400
  main:              "#60A5FA",  // DARK MODE PRIMARY — readable on dark bg
  onMain:            "#0F172A",  // text on primary — dark on light blue
  text:              "#93C5FD",  // primary text in blue context on dark
  textActive:        "#BFDBFE",  // highest emphasis — near white blue
};

const secondary: ColorValueType = {
  bg:                "#1e293b",
  bgActive:          "#334155",
  bgSecondary:       "#0f172a",
  bgSecondaryActive: "#1e293b",
  border:            "#475569",
  borderActive:      "#64748b",
  active:            "#94a3b8",
  main:              "#94a3b8",
  onMain:            "#ffffff",
  text:              "#cbd5e1",
  textActive:        "#f1f5f9",
};

const blue: ColorValueType = {
  bg:                "#1E3A8A",
  bgActive:          "#1E40AF",
  bgSecondary:       "#0F172A",
  bgSecondaryActive: "#1E293B",
  border:            "#2563EB",
  borderActive:      "#3B82F6",
  active:            "#60A5FA",
  main:              "#60A5FA",
  onMain:            "#0F172A",
  text:              "#93C5FD",
  textActive:        "#BFDBFE",
};

// orange: domain use — purchase icon bg, supplier card accent on dark
const orange: ColorValueType = {
  bg:                "#2D1A00",
  bgActive:          "#3D2400",
  bgSecondary:       "#1F1200",
  bgSecondaryActive: "#2D1A00",
  border:            "#BA7517",
  borderActive:      "#D99A2E",
  active:            "#EFBD6D",
  main:              "#FBD07A",  // readable amber on dark bg
  onMain:            "#1F1200",
  text:              "#FAEEDA",
  textActive:        "#FDF6EE",
};

const violet: ColorValueType = {
  bg:                "#1a0f33",
  bgActive:          "#24154d",
  bgSecondary:       "#0f0a1f",
  bgSecondaryActive: "#1a0f33",
  border:            "#8758F2",
  borderActive:      "#A078FF",
  active:            "#B89BFF",
  main:              "#C4B5FD",
  onMain:            "#1a0f33",
  text:              "#DDD6FE",
  textActive:        "#EDE9FE",
};

const green: ColorValueType = {
  bg:                "#052e16",
  bgActive:          "#064E3B",
  bgSecondary:       "#022c16",
  bgSecondaryActive: "#052e16",
  border:            "#16A34A",
  borderActive:      "#22C55E",
  active:            "#4ADE80",
  main:              "#4ADE80",  // bright readable green on dark — paid, money in
  onMain:            "#052e16",
  text:              "#86EFAC",
  textActive:        "#BBF7D0",
};

const red: ColorValueType = {
  bg:                "#450A0A",
  bgActive:          "#5A0F0F",
  bgSecondary:       "#350606",
  bgSecondaryActive: "#450A0A",
  border:            "#DC2626",
  borderActive:      "#EF4444",
  active:            "#F87171",
  main:              "#F87171",  // bright readable red on dark — error, outstanding
  onMain:            "#450A0A",
  text:              "#FCA5A5",
  textActive:        "#FECACA",
};

// warning: semantic — trial expiry, low stock, pending sync, past due
const warning: ColorValueType = {
  bg:                "#2D1A00",
  bgActive:          "#3D2400",
  bgSecondary:       "#1F1200",
  bgSecondaryActive: "#2D1A00",
  border:            "#BA7517",
  borderActive:      "#D99A2E",
  active:            "#EFBD6D",
  main:              "#FBD07A",  // readable warning amber on dark bg
  onMain:            "#1F1200",
  text:              "#FAEEDA",
  textActive:        "#FDF6EE",
};

// financial: POS-specific dark mode amount colors
export const financial: ColorValueType = {
  bg:                "#052e16",  // positive amount background on dark
  bgActive:          "#450A0A",  // negative amount background on dark
  bgSecondary:       "#1f2937",  // neutral/zero background on dark
  bgSecondaryActive: "#374151",
  border:            "#4ADE80",  // positive border
  borderActive:      "#F87171",  // negative border
  active:            "#9CA3AF",  // neutral/zero color
  main:              "#4ADE80",  // positive amount — bright green on dark
  onMain:            "#052e16",
  text:              "#F87171",  // negative amount — bright red on dark
  textActive:        "#9CA3AF",  // zero balance — muted gray
};

const defaultColor: ColorValueType = {
  bg:                "#1f1f1f",
  bgActive:          "#2c2c2c",
  bgSecondary:       "#141414",
  bgSecondaryActive: "#1a1a1a",
  border:            "#3a3a3a",
  borderActive:      "#565656",
  active:            "#6b6b6b",
  main:              "#d1d5db",
  onMain:            "#111827",
  text:              "#d9d9d9",
  textActive:        "#ffffff",
};

const grey: ColorValueType = {
  bg:                "#1f2937",
  bgActive:          "#374151",
  bgSecondary:       "#111827",
  bgSecondaryActive: "#1f2937",
  border:            "#4b5563",
  borderActive:      "#6b7280",
  active:            "#9ca3af",
  main:              "#d1d5db",
  onMain:            "#111827",
  text:              "#e5e7eb",
  textActive:        "#f9fafb",
};

// ─── Semantic map ─────────────────────────────────────────────────────────────

export const darkSemanticColors: SemanticColorMap = {
  primary,
  secondary,
  blue,
  orange,
  violet,
  green,
  red,
  danger:    red,
  success:   green,
  warning,
  default:   defaultColor,
  grey,
};

// ─── Flat token map ───────────────────────────────────────────────────────────

export const darkColorTokens = {
  // ── Primary brand (Blue 400 #60A5FA — readable on dark surfaces) ──────
  colorPrimaryBg:          "#1E3A8A",  // icon/avatar container — brand navy on dark
  colorPrimaryBgHover:     "#1E40AF",
  colorPrimaryBorder:      "#2563EB",
  colorPrimaryBorderHover: "#3B82F6",
  colorPrimaryHover:       "#93C5FD",
  colorPrimary:            "#60A5FA",  // DARK MODE INTERACTIVE — Blue 400
  onColorPrimary:          "#0F172A",  // dark text on light blue button
  colorPrimaryActive:      "#BFDBFE",  // lightest — pressed state text
  colorPrimaryTextHover:   "#93C5FD",
  colorPrimaryText:        "#60A5FA",
  colorPrimaryTextActive:  "#93C5FD",

  // ── Success (green — paid, money in, synced) ───────────────────────────
  colorSuccessBg:          "#052e16",
  colorSuccessBgHover:     "#064E3B",
  colorSuccessBorder:      "#16A34A",
  colorSuccessBorderHover: "#22C55E",
  colorSuccessHover:       "#4ADE80",
  colorSuccess:            "#4ADE80",  // bright green readable on dark
  colorSuccessActive:      "#86EFAC",
  colorSuccessTextHover:   "#86EFAC",
  colorSuccessText:        "#4ADE80",
  colorSuccessTextActive:  "#BBF7D0",

  // ── Warning (amber — trial, pending, low stock, past due) ──────────────
  colorWarningBg:          "#2D1A00",
  colorWarningBgHover:     "#3D2400",
  colorWarningBorder:      "#BA7517",
  colorWarningBorderHover: "#D99A2E",
  colorWarningHover:       "#EFBD6D",
  colorWarning:            "#FBD07A",  // readable amber on dark
  colorWarningActive:      "#FAEEDA",
  colorWarningTextHover:   "#FAEEDA",
  colorWarningText:        "#FBD07A",
  colorWarningTextActive:  "#FDF6EE",

  // ── Error / Danger (red — outstanding, voided, delete) ─────────────────
  colorErrorBg:            "#450A0A",
  colorErrorBgHover:       "#5A0F0F",
  colorErrorBorder:        "#DC2626",
  colorErrorBorderHover:   "#EF4444",
  colorErrorHover:         "#F87171",
  colorError:              "#F87171",  // readable red on dark
  colorErrorActive:        "#FCA5A5",
  colorErrorTextHover:     "#FCA5A5",
  colorErrorText:          "#F87171",
  colorErrorTextActive:    "#FECACA",

  // ── Info (blue — banners, tooltips, help) ─────────────────────────────
  colorInfoBg:             "#1E3A8A",
  colorInfoBgHover:        "#1E40AF",
  colorInfoBorder:         "#2563EB",
  colorInfoBorderHover:    "#3B82F6",
  colorInfoHover:          "#60A5FA",
  colorInfo:               "#60A5FA",
  colorInfoActive:         "#93C5FD",
  colorInfoTextHover:      "#93C5FD",
  colorInfoText:           "#60A5FA",
  colorInfoTextActive:     "#BFDBFE",

  // ── Financial amounts (POS-specific dark mode) ─────────────────────────
  colorAmountPositive:     "#4ADE80",  // ₹1,250 received — bright green on dark
  colorAmountNegative:     "#F87171",  // ₹850 outstanding — bright red on dark
  colorAmountNeutral:      "#64748B",  // ₹0.00 zero balance — slate gray
  colorAmountHero:         "#F1F5F9",  // large display total — near white on dark

  // ── Links ─────────────────────────────────────────────────────────────
  colorLinkHover:          "#93C5FD",
  colorLinkActive:         "#BFDBFE",

  // ── Text ──────────────────────────────────────────────────────────────
  colorText:               "#F1F5F9",  // primary — near white on slate
  colorTextSecondary:      "#94A3B8",  // secondary — slate-400
  colorTextTertiary:       "#64748B",  // tertiary — slate-500
  colorTextQuaternary:     "#475569",  // disabled — slate-600

  // ── Borders ───────────────────────────────────────────────────────────
  colorBorder:             "#334155",  // default border on dark surfaces — slate-700
  colorBorderSecondary:    "#1E293B",  // subtle separator — slate-800
  colorBorderFocus:        "#60A5FA",  // focus ring — Blue 400 on dark

  // ── Fill overlays ─────────────────────────────────────────────────────
  colorFill:               "rgba(255, 255, 255, 0.12)",
  colorFillSecondary:      "rgba(255, 255, 255, 0.08)",
  colorFillTertiary:       "rgba(255, 255, 255, 0.05)",
  colorFillQuaternary:     "rgba(255, 255, 255, 0.02)",

  // ── Backgrounds ───────────────────────────────────────────────────────
  colorBgPage:             "#0F172A",  // page/screen background — slate-900
  colorBgContainer:        "#1E293B",  // cards, list items — slate-800
  colorBgElevated:         "#334155",  // elevated sheets, dropdowns — slate-700
  colorBgInput:            "#1E293B",  // text input background — slate-800
  colorBgLayout:           "#0F172A",  // tab bar, layout — slate-900
  colorBgSpotlight:        "#1E3A8A",  // store card background — brand navy
  colorBgMask:             "rgba(15, 23, 42, 0.75)",  // modal backdrop

  colorWhite:              "#ffffff",
  transparent:             "transparent",
} as const;

// ─── Extended palette (full ramp scales) ─────────────────────────────────────

export const darkExtendedPalette = {
  // ── Domain accent backgrounds (dark mode — dark bg, light text) ────────
  colorNavy:      "#60A5FA",   // interactive navy on dark
  navyBg:         "#1E3A8A",   // container bg — brand navy
  colorGreen:     "#4ADE80",
  greenBg:        "#052e16",
  colorAmber:     "#FBD07A",
  amberBg:        "#2D1A00",
  colorRed:       "#F87171",
  redBg:          "#450A0A",
  colorViolet:    "#C4B5FD",
  violetBg:       "#1a0f33",
  colorGray:      "#94A3B8",

  // Store card gradient — brand navy to mid blue (same as light mode)
  gradientStoreCard:
    "linear-gradient(135deg, #1E3A8A 0%, #2563EB 100%)",

  // Layout background gradient — subtle dark navy
  gradientLayoutBg:
    "linear-gradient(135deg, #1E293B 0%, #0F172A 40%, #0F172A 80%, #1E293B 100%)",

  // ── Navy ramp (brand — dark mode shows lighter stops) ─────────────────
  navy50:         "#EFF6FF",
  navy100:        "#DBEAFE",
  navy200:        "#BFDBFE",
  navy300:        "#93C5FD",
  navy400:        "#60A5FA",   // dark mode primary interactive
  navy500:        "#3B82F6",
  navy600:        "#2563EB",
  navy700:        "#1E40AF",
  navy800:        "#1E3A8A",   // light mode primary / dark mode icon bg
  navy900:        "#1E2F6E",

  // ── Slate ramp (dark mode surfaces) ────────────────────────────────────
  slate900:       "#0F172A",   // colorBgPage
  slate800:       "#1E293B",   // colorBgContainer
  slate700:       "#334155",   // colorBgElevated / colorBorder
  slate600:       "#475569",   // colorTextQuaternary
  slate500:       "#64748B",   // colorTextTertiary
  slate400:       "#94A3B8",   // colorTextSecondary
  slate300:       "#CBD5E1",
  slate200:       "#E2E8F0",
  slate100:       "#F1F5F9",   // colorText on dark
  slate50:        "#F8FAFC",

  // ── Green ramp (success — dark mode) ──────────────────────────────────
  green50:        "#BBF7D0",
  green100:       "#86EFAC",
  green200:       "#4ADE80",   // dark mode success main
  green400:       "#22C55E",
  green600:       "#16A34A",   // light mode success main
  green800:       "#064E3B",
  green900:       "#052e16",   // dark mode success bg

  // ── Red ramp (error — dark mode) ───────────────────────────────────────
  red50:          "#FECACA",
  red100:         "#FCA5A5",
  red200:         "#F87171",   // dark mode error main
  red400:         "#EF4444",
  red600:         "#DC2626",   // light mode error main
  red800:         "#5A0F0F",
  red900:         "#450A0A",   // dark mode error bg

  // ── Amber ramp (warning — dark mode) ──────────────────────────────────
  amber50:        "#FDF6EE",
  amber100:       "#FAEEDA",
  amber200:       "#FBD07A",   // dark mode warning main
  amber400:       "#EFBD6D",
  amber600:       "#D97706",   // light mode warning main
  amber800:       "#3D2400",
  amber900:       "#2D1A00",   // dark mode warning bg

  // ── Violet ramp (optional accent — dark mode) ──────────────────────────
  violet50:       "#EDE9FE",
  violet100:      "#DDD6FE",
  violet200:      "#C4B5FD",   // dark mode violet main
  violet400:      "#A78BFA",
  violet600:      "#8758F2",
  violet800:      "#24154d",
  violet900:      "#1a0f33",   // dark mode violet bg

  // ── Neutral gray ramp (universal — same in light and dark) ─────────────
  gray50:         "#F9FAFB",
  gray100:        "#F3F4F6",
  gray200:        "#E5E7EB",
  gray300:        "#D1D5DB",
  gray400:        "#9CA3AF",
  gray500:        "#6B7280",
  gray600:        "#4B5563",
  gray700:        "#374151",
  gray800:        "#1F2937",
  gray900:        "#111827",
} as const;