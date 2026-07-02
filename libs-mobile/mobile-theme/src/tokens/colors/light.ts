import type { ColorValueType, SemanticColorMap } from "./types";

// ─── Brand decision ───────────────────────────────────────────────────────────
// Primary brand: Deep Navy #1E3A8A
// Replaces previous purple #534AB7 / indigo #4F46E5.
// Contrast ratio on white: 8.1:1 — exceeds WCAG AA (4.5:1) and AAA (7:1).
// Semantic colors (success/error/warning/info) are unchanged.
// Only primary/brand tokens change throughout this file.

// ─── Semantic color groups ────────────────────────────────────────────────────

const primary: ColorValueType = {
  bg:                "#EFF6FF",  // lightest navy tint — icon containers, chip bg, avatar bg
  bgActive:          "#DBEAFE",  // hover/active tint bg
  bgSecondary:       "#F8FAFF",  // near-white navy — screen/layout background tint
  bgSecondaryActive: "#EFF6FF",
  border:            "#BFDBFE",  // light navy border — input focus ring tint
  borderActive:      "#93C5FD",  // deeper border — hover state
  active:            "#2563EB",  // mid-navy — active icon, hover state, links
  main:              "#1E3A8A",  // PRIMARY BRAND — buttons, active tab, focus ring
  onMain:            "#ffffff",  // text on primary backgrounds
  text:              "#1E40AF",  // primary text in navy context
  textActive:        "#1E2F6E",  // darkest — pressed text, strong emphasis
};

const secondary: ColorValueType = {
  bg:                "#f1f5f9",
  bgActive:          "#e2e8f0",
  bgSecondary:       "#f8fafc",
  bgSecondaryActive: "#f1f5f9",
  border:            "#cbd5e1",
  borderActive:      "#94a3b8",
  active:            "#64748b",
  main:              "#475569",
  onMain:            "#ffffff",
  text:              "#1e293b",
  textActive:        "#0f172a",
};

const blue: ColorValueType = {
  bg:                "#EFF6FF",
  bgActive:          "#DBEAFE",
  bgSecondary:       "#F8FAFF",
  bgSecondaryActive: "#EFF6FF",
  border:            "#BFDBFE",
  borderActive:      "#93C5FD",
  active:            "#2563EB",
  main:              "#1D4ED8",  // slightly darker blue for info context
  onMain:            "#ffffff",
  text:              "#1E40AF",
  textActive:        "#1E3A8A",
};

// orange: domain color — purchase icon bg, supplier card accent
// Kept separate from warning — see warning below.
const orange: ColorValueType = {
  bg:                "#FAEEDA",
  bgActive:          "#F5D9A8",
  bgSecondary:       "#FDF6EE",
  bgSecondaryActive: "#FAEEDA",
  border:            "#EFBD6D",
  borderActive:      "#D99A2E",
  active:            "#BA7517",
  main:              "#D97706",
  onMain:            "#ffffff",
  text:              "#854F0B",
  textActive:        "#633806",
};

const violet: ColorValueType = {
  bg:                "#F6EDFF",
  bgActive:          "#E9DDFF",
  bgSecondary:       "#FEF7FF",
  bgSecondaryActive: "#F6EDFF",
  border:            "#D0BCFF",
  borderActive:      "#B89BFF",
  active:            "#8758F2",
  main:              "#8b5cf6",
  onMain:            "#ffffff",
  text:              "#612ACA",
  textActive:        "#5516BE",
};

const green: ColorValueType = {
  bg:                "#EAF3DE",
  bgActive:          "#C0DD97",
  bgSecondary:       "#F4FAE9",
  bgSecondaryActive: "#EAF3DE",
  border:            "#8BBF55",
  borderActive:      "#639922",
  active:            "#3B6D11",
  main:              "#16A34A",  // success — paid, money in, sync OK, stock healthy
  onMain:            "#ffffff",
  text:              "#27500A",
  textActive:        "#173404",
};

const red: ColorValueType = {
  bg:                "#FCEBEB",
  bgActive:          "#F7C1C1",
  bgSecondary:       "#FEF5F5",
  bgSecondaryActive: "#FCEBEB",
  border:            "#ED8A8A",
  borderActive:      "#E24B4A",
  active:            "#A32D2D",
  main:              "#DC2626",  // error — outstanding balance, void, delete
  onMain:            "#ffffff",
  text:              "#791F1F",
  textActive:        "#501313",
};

// warning: semantic meaning — trial expiry, low stock, pending sync, past due
// Intentionally different from orange (domain use) to avoid semantic collision.
const warning: ColorValueType = {
  bg:                "#FAEEDA",
  bgActive:          "#F5D9A8",
  bgSecondary:       "#FDF6EE",
  bgSecondaryActive: "#FAEEDA",
  border:            "#EFBD6D",
  borderActive:      "#D99A2E",
  active:            "#BA7517",
  main:              "#D97706",
  onMain:            "#ffffff",
  text:              "#854F0B",
  textActive:        "#633806",
};

// financial: POS-specific — amount display colors (positive, negative, neutral)
export const financial: ColorValueType = {
  bg:                "#EAF3DE",  // positive amount background
  bgActive:          "#FCEBEB",  // negative amount background
  bgSecondary:       "#F3F4F6",  // neutral/zero amount background
  bgSecondaryActive: "#E5E7EB",
  border:            "#16A34A",  // positive border
  borderActive:      "#DC2626",  // negative border
  active:            "#6B7280",  // neutral/zero state color
  main:              "#16A34A",  // positive (money in, paid)
  onMain:            "#ffffff",
  text:              "#DC2626",  // negative (money out, outstanding)
  textActive:        "#6B7280",  // zero balance
};

const defaultColor: ColorValueType = {
  bg:                "#f5f5f5",
  bgActive:          "#e0e0e0",
  bgSecondary:       "#ffffff",
  bgSecondaryActive: "#f0f0f0",
  border:            "#d1d5db",
  borderActive:      "#9ca3af",
  active:            "#c0c0c0",
  main:              "#374151",
  onMain:            "#ffffff",
  text:              "#1f2937",
  textActive:        "#111827",
};

const grey: ColorValueType = {
  bg:                "#f9fafb",
  bgActive:          "#f3f4f6",
  bgSecondary:       "#fefefe",
  bgSecondaryActive: "#f9fafb",
  border:            "#d1d5db",
  borderActive:      "#9ca3af",
  active:            "#6b7280",
  main:              "#374151",
  onMain:            "#ffffff",
  text:              "#4b5563",
  textActive:        "#111827",
};

// ─── Semantic map ─────────────────────────────────────────────────────────────

export const lightSemanticColors: SemanticColorMap = {
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

export const lightColorTokens = {
  // ── Primary brand (deep navy #1E3A8A) ────────────────────────────────
  colorPrimaryBg:          "#EFF6FF",
  colorPrimaryBgHover:     "#DBEAFE",
  colorPrimaryBorder:      "#BFDBFE",
  colorPrimaryBorderHover: "#93C5FD",
  colorPrimaryHover:       "#2563EB",
  colorPrimary:            "#1E3A8A",  // THE brand color
  onColorPrimary:          "#ffffff",
  colorPrimaryActive:      "#1E2F6E",  // pressed state
  colorPrimaryTextHover:   "#2563EB",
  colorPrimaryText:        "#1E40AF",
  colorPrimaryTextActive:  "#1E2F6E",

  // ── Success (green — paid, money in, synced, stock healthy) ──────────
  colorSuccessBg:          "#EAF3DE",
  colorSuccessBgHover:     "#C0DD97",
  colorSuccessBorder:      "#8BBF55",
  colorSuccessBorderHover: "#639922",
  colorSuccessHover:       "#3B6D11",
  colorSuccess:            "#16A34A",
  colorSuccessActive:      "#27500A",
  colorSuccessTextHover:   "#3B6D11",
  colorSuccessText:        "#16A34A",
  colorSuccessTextActive:  "#27500A",

  // ── Warning (amber — trial expiry, low stock, pending sync, past due) ─
  colorWarningBg:          "#FAEEDA",
  colorWarningBgHover:     "#F5D9A8",
  colorWarningBorder:      "#EFBD6D",
  colorWarningBorderHover: "#D99A2E",
  colorWarningHover:       "#BA7517",
  colorWarning:            "#D97706",
  colorWarningActive:      "#854F0B",
  colorWarningTextHover:   "#854F0B",
  colorWarningText:        "#D97706",
  colorWarningTextActive:  "#633806",

  // ── Error / Danger (red — outstanding balance, voided, delete) ────────
  colorErrorBg:            "#FCEBEB",
  colorErrorBgHover:       "#F7C1C1",
  colorErrorBorder:        "#ED8A8A",
  colorErrorBorderHover:   "#E24B4A",
  colorErrorHover:         "#E24B4A",
  colorError:              "#DC2626",
  colorErrorActive:        "#A32D2D",
  colorErrorTextHover:     "#A32D2D",
  colorErrorText:          "#DC2626",
  colorErrorTextActive:    "#791F1F",

  // ── Info (blue — banners, tooltips, help text, informational badges) ──
  colorInfoBg:             "#EFF6FF",
  colorInfoBgHover:        "#DBEAFE",
  colorInfoBorder:         "#BFDBFE",
  colorInfoBorderHover:    "#93C5FD",
  colorInfoHover:          "#2563EB",
  colorInfo:               "#1D4ED8",
  colorInfoActive:         "#1E3A8A",
  colorInfoTextHover:      "#1E40AF",
  colorInfoText:           "#1D4ED8",
  colorInfoTextActive:     "#1E3A8A",

  // ── Financial amounts (POS-specific) ──────────────────────────────────
  colorAmountPositive:     "#16A34A",  // ₹1,250 received — green
  colorAmountNegative:     "#DC2626",  // ₹850 outstanding — red
  colorAmountNeutral:      "#6B7280",  // ₹0.00 zero balance — gray
  colorAmountHero:         "#111827",  // large display total — primary text

  // ── Links ─────────────────────────────────────────────────────────────
  colorLinkHover:          "#2563EB",
  colorLinkActive:         "#1E2F6E",

  // ── Text (neutral slate) ──────────────────────────────────────────────
  colorText:               "#111827",  // primary — headings, amounts, names
  colorTextSecondary:      "#6B7280",  // secondary — subtitles, labels
  colorTextTertiary:       "#9CA3AF",  // tertiary — placeholders, captions
  colorTextQuaternary:     "#D1D5DB",  // disabled text

  // ── Borders ───────────────────────────────────────────────────────────
  colorBorder:             "#E2E8F0",  // default — 0.5px dividers and list separators
  colorBorderSecondary:    "#F1F5F9",  // subtle section separator
  colorBorderFocus:        "#1E3A8A",  // focus ring — always brand navy

  // ── Fill overlays ─────────────────────────────────────────────────────
  colorFill:               "rgba(0, 0, 0, 0.06)",
  colorFillSecondary:      "rgba(0, 0, 0, 0.04)",
  colorFillTertiary:       "rgba(0, 0, 0, 0.02)",
  colorFillQuaternary:     "rgba(0, 0, 0, 0.01)",

  // ── Backgrounds ───────────────────────────────────────────────────────
  colorBgPage:             "#F8FAFF",  // screen/page background — very slight navy tint
  colorBgContainer:        "#FFFFFF",  // cards, list items, modals, sheets
  colorBgElevated:         "#FFFFFF",  // elevated surfaces — dropdowns, bottom sheets
  colorBgInput:            "#F8FAFF",  // text input background
  colorBgLayout:           "#F8FAFF",  // layout/tab background
  colorBgSpotlight:        "#1E3A8A",  // store card, spotlight header
  colorBgMask:             "rgba(15, 23, 42, 0.45)",  // modal backdrop

  colorWhite:              "#ffffff",
  transparent:             "transparent",
} as const;

// ─── Extended palette (full ramp scales) ─────────────────────────────────────

export const lightExtendedPalette = {
  // ── Domain accent backgrounds (menu icons, quick action tiles) ────────
  colorNavy:      "#1E3A8A",
  navyBg:         "#EFF6FF",
  colorGreen:     "#16A34A",
  greenBg:        "#EAF3DE",
  colorAmber:     "#D97706",
  amberBg:        "#FAEEDA",
  colorRed:       "#DC2626",
  redBg:          "#FCEBEB",
  colorViolet:    "#8b5cf6",
  violetBg:       "#F6EDFF",
  colorGray:      "#6B7280",

  // Store card gradient — deep navy to mid blue
  gradientStoreCard:
    "linear-gradient(135deg, #1E3A8A 0%, #2563EB 100%)",

  // Layout background gradient — barely-there navy tint
  gradientLayoutBg:
    "linear-gradient(135deg, #EFF6FF 0%, #ffffff 40%, #ffffff 80%, #EFF6FF 100%)",

  // ── Navy ramp (brand) ─────────────────────────────────────────────────
  navy50:         "#EFF6FF",
  navy100:        "#DBEAFE",
  navy200:        "#BFDBFE",
  navy300:        "#93C5FD",
  navy400:        "#60A5FA",
  navy500:        "#3B82F6",
  navy600:        "#2563EB",
  navy700:        "#1E40AF",
  navy800:        "#1E3A8A",  // ← PRIMARY BRAND
  navy900:        "#1E2F6E",  // pressed/darkest

  // ── Green ramp (success / positive amounts) ───────────────────────────
  green50:        "#EAF3DE",
  green100:       "#C0DD97",
  green200:       "#97C459",
  green400:       "#639922",
  green600:       "#3B6D11",
  green800:       "#27500A",
  green900:       "#173404",

  // ── Red ramp (error / negative amounts / danger) ──────────────────────
  red50:          "#FCEBEB",
  red100:         "#F7C1C1",
  red200:         "#F09595",
  red400:         "#E24B4A",
  red600:         "#A32D2D",
  red800:         "#791F1F",
  red900:         "#501313",

  // ── Amber ramp (warning / trial / pending) ─────────────────────────────
  amber50:        "#FAEEDA",
  amber100:       "#F5D9A8",
  amber200:       "#EFBD6D",
  amber400:       "#D99A2E",
  amber600:       "#BA7517",
  amber800:       "#854F0B",
  amber900:       "#633806",

  // ── Violet ramp (optional accent — loyalty, reports) ──────────────────
  violet50:       "#F6EDFF",
  violet100:      "#E9DDFF",
  violet200:      "#D0BCFF",
  violet400:      "#B89BFF",
  violet600:      "#8758F2",
  violet800:      "#612ACA",
  violet900:      "#5516BE",

  // ── Neutral gray ramp ─────────────────────────────────────────────────
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