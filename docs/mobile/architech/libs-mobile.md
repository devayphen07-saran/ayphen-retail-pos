# NKS Mobile Libraries — Developer Guide

> **Scope**: This document governs all code written inside `libs-mobile/mobile-theme` and `libs-mobile/mobile-ui-components`.
> Read it before creating any component, token, or folder inside this library.

---

## Table of Contents

1. [Library Overview](#1-library-overview)
2. [Monorepo Structure](#2-monorepo-structure)
3. [@nks/mobile-theme — Theme Library](#3-nksmobile-theme--theme-library)
   - [Token Architecture](#31-token-architecture)
   - [Color Tokens](#32-color-tokens)
   - [Typography Tokens](#33-typography-tokens)
   - [Spacing & Border Tokens](#34-spacing--border-tokens)
   - [Effects Tokens (shadow / overlay / gradient)](#34a-effects-tokens-shadow-overlay-gradient)
   - [ThemeProvider & Hooks](#35-themeprovider--hooks)
4. [@nks/mobile-ui-components — UI Component Library](#4-nksmobile-ui-components--ui-component-library)
   - [Component Catalogue](#41-component-catalogue)
   - [Typography Component](#42-typography-component)
   - [Form Components](#43-form-components)
   - [Layout Primitives](#44-layout-primitives)
5. [Mandatory Styling Rules](#5-mandatory-styling-rules)
   - [Styled-Components Syntax](#51-styled-components-syntax)
   - [File Layout](#52-file-layout)
6. [Creating New Components](#6-creating-new-components)
7. [Creating New Theme Tokens](#7-creating-new-theme-tokens)
8. [Rules Checklist](#8-rules-checklist)

---

## 1. Library Overview

The NKS mobile design system is split into two focused workspace packages:

| Package                     | Path                               | Role                                    |
| --------------------------- | ---------------------------------- | --------------------------------------- |
| `@nks/mobile-theme`         | `libs-mobile/mobile-theme`         | Design tokens, ThemeProvider, and hooks |
| `@nks/mobile-ui-components` | `libs-mobile/mobile-ui-components` | All shared UI components                |

Every mobile app in the monorepo imports **only** from these two packages. Styling logic must never live in the app layer.

---

## 2. Monorepo Structure

```
ayphen-retail-pos/
├── apps/                          ← Consumer apps (import only from libs-mobile/*)
└── libs-mobile/
    ├── mobile-theme/              ← @nks/mobile-theme
    │   └── src/
    │       ├── tokens/            ← Pure data: colors, typography, spacing, effects, breakpoints
    │       │   ├── colors/        ← types.ts, light.ts, dark.ts
    │       │   ├── typography.ts
    │       │   ├── spacing.ts
    │       │   ├── effects.ts     ← shadow, overlay, gradient, brandColorTokens, componentSizing
    │       │   ├── breakpoints.ts
    │       │   └── index.ts       ← Assembles lightTheme / darkTheme + NKSTheme type
    │       ├── types/
    │       │   └── styled.d.ts    ← Augments styled-components DefaultTheme with NKSTheme
    │       ├── ThemeProvider.tsx  ← MobileThemeProvider, useMobileTheme, useColorVariant
    │       ├── useBreakpoint.ts   ← Responsive hooks (useBreakpoint, useScaledSize, …)
    │       └── index.ts           ← Public API
    └── mobile-ui-components/       ← @nks/mobile-ui-components
        └── src/
            ├── lib/               ← One folder per component
            └── index.ts           ← Public barrel export
```

> **Rule**: Apps must **never** import from a sub-path like `@nks/mobile-theme/src/tokens`.  
> Always import from the package root: `import { ... } from "@nks/mobile-theme"`.

---

## 3. @nks/mobile-theme — Theme Library

### 3.1 Token Architecture

Tokens are organized in three layers:

```
tokens/
├── colors/
│   ├── types.ts      ← ColorValueType, ColorVariantKey, ColorType, SemanticColorMap
│   ├── light.ts      ← Light mode semantic colors + flat tokens + extended palette
│   └── dark.ts       ← Dark mode semantic colors + flat tokens + extended palette
├── typography.ts     ← fontSize, fontFamily, fontWeight, lineHeight, typographyTokens
├── spacing.ts        ← sizing, spacing (margin/padding), borderRadius, borderWidth
├── effects.ts        ← shadow, overlay, gradient, brandColorTokens, componentSizing
├── breakpoints.ts    ← breakpoints, deviceScale, fontScale, resolveBreakpoint
└── index.ts          ← Assembles lightTheme / darkTheme + exports NKSTheme type
```

The assembled result is a strongly-typed `NKSTheme` object accessible in every styled-component via `props.theme`.

### 3.2 Color Tokens

#### Semantic Color Groups

Each semantic color (e.g. `primary`, `danger`) exposes a standardized `ColorValueType` slot:

```typescript
interface ColorValueType {
  bg: string; // Light background (used for chips, badges)
  bgActive: string; // Hovered/pressed light background
  bgSecondary: string; // Even lighter background
  bgSecondaryActive: string; // Hovered secondary background
  border: string; // Default border
  borderActive: string; // Hovered/focused border
  active: string; // Active/pressed text or icon color
  main: string; // The primary brand color for this variant
  onMain: string; // Text/icon color on top of `main` (usually white)
  text: string; // Text color for this variant
  textActive: string; // Active/hovered text color
}
```

**Available semantic color keys** (`ColorVariantKey`):

| Key         | Usage                                                             |
| ----------- | ---------------------------------------------------------------- |
| `primary`   | Brand color — navy `#1E3A8A` (`main`)                             |
| `secondary` | Neutral slate                                                    |
| `success`   | Success states — **alias of `green`** (`#16A34A`)                |
| `danger`    | Errors, destructive actions — **alias of `red`** (`#DC2626`-fam) |
| `warning`   | Amber — trial expiry, low stock, pending sync                    |
| `blue`      | Info, links                                                      |
| `orange`    | Domain accent — purchase icon bg, supplier card                  |
| `violet`    | Extended palette                                                 |
| `green`     | Extended palette (also backs `success`)                          |
| `red`       | Extended palette (also backs `danger`)                           |
| `grey`      | Disabled, placeholder                                            |
| `default`   | General text, neutral elements                                   |

> **Note**: `danger` and `success` are **aliases** — in `light.ts`/`dark.ts` they are assigned the same objects as `red` and `green` respectively (`danger: red`, `success: green`). Use `danger`/`success` for semantic intent and `red`/`green` for palette decoration.

**`ColorType` runtime object** (use for `variant` props):

```typescript
import { ColorType } from "@nks/mobile-theme";

// ✅ Correct — uses the runtime value object
<MetricCard variant={ColorType.primary} ... />
<MetricCard variant={ColorType.danger} ... />
```

> ⚠️ **Never** pass a raw string like `variant="primary"` unless the prop type is `string`. Always use `ColorType.xxx` for type safety.

#### Flat Color Tokens

These live directly on `theme.*` and map to semantic intentions:

```typescript
theme.colorPrimary; // #1E3A8A — THE brand color (buttons, active tab, focus ring)
theme.colorPrimaryText; // #1E40AF — primary-colored text
theme.colorPrimaryBg; // #EFF6FF — lightest navy tint (chips, icon containers)
theme.onColorPrimary; // #ffffff — text/icon on a primary surface
theme.colorBgContainer; // Card / surface background
theme.colorBgLayout; // Page / screen background
theme.colorText; // Primary body text
theme.colorTextSecondary; // Muted / secondary text
theme.colorBorder; // Default border
theme.colorBorderSecondary; // Dividers, subtle borders
theme.colorSuccess; // Success green
theme.colorWarning; // Warning amber
theme.colorError; // Error red
theme.colorWhite; // #ffffff
```

> The full flat-token set lives in `tokens/colors/light.ts` (and `dark.ts`). The primary
> family also exposes `colorPrimaryHover`, `colorPrimaryActive`, `colorPrimaryBorder`,
> `colorPrimaryBorderHover`, `colorPrimaryBgHover`, and `colorPrimaryTextHover`.

#### Accessing Semantic Colors in Components

```typescript
// Via the theme.color map:
theme.color.primary.bg; // #EFF6FF — lightest navy tint background
theme.color.primary.main; // #1E3A8A — brand navy
theme.color.danger.border; // Red border
theme.color.success.onMain; // White (text on green button)

// Via the useColorVariant hook (place ∈ "main" | "background" | "border"):
const mainColors = useColorVariant({ place: 'main' });
mainColors.primary; // → "#1E3A8A"
mainColors.success; // → "#16A34A"
```

### 3.3 Typography Tokens

```typescript
// Font sizes (in px)
theme.fontSize.xxSmall; // 10 — overline
theme.fontSize.xSmall; // 12 — caption
theme.fontSize.small; // 14 — small body
theme.fontSize.regular; // 16 — default body
theme.fontSize.medium; // 17 — subtitle
theme.fontSize.large; // 18 — h5
theme.fontSize.xLarge; // 20 — h4
theme.fontSize.xxLarge; // 24 — h3
theme.fontSize.h1; // 32
theme.fontSize.h2; // 28

// Font sizes also expose h1–h5 aliases and zero/step:
theme.fontSize.h3; // 24   theme.fontSize.h4; // 20   theme.fontSize.h5; // 18
theme.fontSize.zero; // 0    theme.fontSize.step; // 2

// Font families (all Poppins variants)
theme.fontFamily.poppinsRegular;
theme.fontFamily.poppinsSemiBold;
theme.fontFamily.poppinsBold;
theme.fontFamily.poppinsMedium;
theme.fontFamily.poppinsLight;
theme.fontFamily.poppinsThin;
theme.fontFamily.poppinsItalic;

// Font weights (numeric 100–900)
theme.fontWeight['400']; // 400   theme.fontWeight['600']; // 600

// Line heights — the theme exposes FLAT aliases (not a nested object):
theme.lineHeight; // 1.571… (base body)
theme.lineHeightSM; // 1.666…
theme.lineHeightLG; // 1.5
theme.lineHeightHeading1; // 1.210…  (…Heading2 … Heading5)
```

> **Note**: `theme.lineHeight` is a **flat number**, not a map — `theme.lineHeight.base` does
> not exist on the theme. The nested `lineHeight` object (with `.base`, `.sm`, `.heading1`…)
> is exported separately from `@nks/mobile-theme` for direct import if needed.

### 3.4 Spacing & Border Tokens

```typescript
// Sizing — same scale for margin, padding, gap.
// Also aliased as theme.padding.* and theme.margin.* (both point at this scale).
theme.sizing.zero; // 0
theme.sizing.xxSmall; // 4
theme.sizing.xSmall; // 8
theme.sizing.small; // 12
theme.sizing.medium; // 16
theme.sizing.regular; // 20
theme.sizing.large; // 24
theme.sizing.xLarge; // 32
theme.sizing.xxLarge; // 48
theme.sizing.step; // 4  (base grid step)

// Border radius
theme.borderRadius.zero; // 0
theme.borderRadius.xxSmall; // 1
theme.borderRadius.xSmall; // 2
theme.borderRadius.small; // 4
theme.borderRadius.medium; // 6
theme.borderRadius.regular; // 8
theme.borderRadius.large; // 10
theme.borderRadius.xLarge; // 12
theme.borderRadius.xxLarge; // 14
theme.borderRadius.step; // 2
theme.borderRadius.full; // 9999 — pill / fully-rounded (chips, circles). Use INSTEAD of 9999px.

// Border width — use these modern names:
theme.borderWidth.zero; // 0
theme.borderWidth.mild; // 0.5
theme.borderWidth.thin; // 1
theme.borderWidth.light; // 1.5
theme.borderWidth.medium; // 3
theme.borderWidth.bold; // 4
```

> **Rule**: Never hardcode spacing numbers. Always use `theme.sizing.*` (or `theme.padding.*` /
> `theme.margin.*`) and `theme.borderRadius.*`.
>
> ⚠️ **Deprecated**: `borderWidth` also carries legacy `borderWidthThin` / `borderWidthMild` /
> `borderWidthLight` / `borderWidthMedium` / `borderWidthBold` / `borderWidthZero` aliases for
> backward compat. **Do not use them in new code** — use `theme.borderWidth.thin` etc.

### 3.4a Effects Tokens (shadow, overlay, gradient)

Mode-independent visual effects live on the theme (spread from `effects.ts`). They replace
every hardcoded `#000` shadow, `rgba(…)` overlay, and LinearGradient color array:

```typescript
// Elevation — pre-composed CSS snippets, interpolated directly into a template literal:
theme.shadow.none; theme.shadow.sm; theme.shadow.md; theme.shadow.lg; theme.shadow.top;
//   const Card = styled.View`${({ theme }) => theme.shadow.md}`;

// Overlays / scrims (modal backdrops, on-dark / on-light alpha fills):
theme.overlay.scrim;      // rgba(0,0,0,0.6)
theme.overlay.scrimSoft;  // rgba(0,0,0,0.4)
theme.overlay.onDark08;   // rgba(255,255,255,0.08)  (…onDark04 … onDark55)
theme.overlay.onLight06;  // rgba(0,0,0,0.06)        (…onLight08)

// Brand gradient ramps (feed expo-linear-gradient `colors`) + accent orbs:
theme.gradient.brandHero;   // ["#0D0B26","#1A1754","#2D2A8A"]
theme.gradient.cta;         // ["#4F46E5","#7C3AED"]  (…ctaDisabled, ctaSuccess)
theme.gradient.dashboardHero; theme.gradient.premiumCard;
theme.gradient.orbIndigo;   // "#6366F1"   theme.gradient.orbViolet; // "#7C3AED"

// Fixed brand surfaces (dark by design, both modes):
theme.colorSplashBg;        // #0D0B26   theme.colorBrandSurface; // #0F0E1A
theme.colorAccentLavender;  // #A5B4FC   theme.colorTrustNote;    // #4338CA

// Fixed component dimensions that don't map to the spacing scale:
theme.componentSizing.ctaBtnHeight;      // 54
theme.componentSizing.heroBrandIconSize; // 36
```

> **Rule**: Never write `shadow-color: #000`, `rgba(...)`, or literal gradient arrays in a
> screen. Use `theme.shadow.*`, `theme.overlay.*`, and `theme.gradient.*`.

### 3.5 ThemeProvider & Hooks

Wrap your entire app once in `<MobileThemeProvider>`:

```tsx
// app/_layout.tsx
import { MobileThemeProvider } from '@nks/mobile-theme';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <MobileThemeProvider loadingFallback={<LoadingScreen />}>
        <InnerLayout />
      </MobileThemeProvider>
    </SafeAreaProvider>
  );
}
```

#### `useMobileTheme()`

```typescript
const {
  theme, // NKSTheme — the full resolved token object
  isDarkMode, // boolean — derived from themePreference + system scheme
  themePreference, // ThemePreference — "light" | "dark" | "auto"
  setThemePreference, // (preference: ThemePreference) => Promise<void>  (persists to AsyncStorage)
  isThemeReady, // boolean — false until AsyncStorage resolves
} = useMobileTheme();
```

> ⚠️ There is **no** `toggleTheme` or `setTheme(isDark)`. Persistence is preference-based:
> call `setThemePreference("dark" | "light" | "auto")`. `isDarkMode` is read-only (derived).
> To toggle: `setThemePreference(isDarkMode ? "light" : "dark")`.

#### `useColorVariant()`

```typescript
// Returns a flat map of all variant colors for a specific "place".
// place ∈ "main" | "background" | "border"
const mainColors = useColorVariant({ place: 'main' }); // { primary, danger, success, ... }
const bgColors = useColorVariant({ place: 'background' }); // { primary, danger, ... }
const borderColors = useColorVariant({ place: 'border' });
```

#### Responsive hooks (`useBreakpoint.ts`)

```typescript
const { breakpoint, isPhone, isTablet, width } = useBreakpoint(); // BreakpointInfo
const cols = useResponsiveValue({ phone: 1, tablet: 2, largeTablet: 3 }); // ResponsiveValue<T>
const size = useScaledSize(16);   // scales a dimension by deviceScale per breakpoint
const font = useScaledFont(14);   // scales a font size by fontScale per breakpoint
```

Breakpoints: `phone: 0`, `tablet: 600`, `largeTablet: 1024`. Also exported: `resolveBreakpoint(width)`,
`deviceScale`, `fontScale`, and the `breakpoints` map.

---

## 4. @nks/mobile-ui-components — UI Component Library

### 4.1 Component Catalogue

All components import from the package root `@nks/mobile-ui-components`. The table below is
generated from the actual barrel (`src/index.ts`) and `src/lib/` folders.

**Forms & inputs**

| Component        | Description                                       |
| ---------------- | ------------------------------------------------- |
| `Input`          | RHF-controlled text input with label & error      |
| `PasswordInput`  | Input with show/hide toggle                        |
| `SearchInput`    | Search bar with icon                               |
| `TextArea`       | Multi-line input                                   |
| `MaskedInput`    | Masked text input (`masked-input`)                 |
| `OtpInput`       | OTP / PIN entry (`otp-input`)                       |
| `CheckBox`       | Controlled or RHF-integrated checkbox              |
| `Switch`         | Animated toggle, uncontrolled or RHF               |
| `RadioGroup`     | Group of radio options                             |
| `Form`           | Form helpers / wrappers (`form`)                   |

**Selects**

| Component          | Description                                            |
| ------------------ | ----------------------------------------------------- |
| `SelectGeneric`    | Generic dropdown select (default export from `Select`)|
| `ConfigSelectItem` | Config row inside a Select                             |
| `ModalSelect`      | Single / multi-select modal                           |
| `BaseSelectItem`   | Single item in a select list                          |
| `DateTimePicker`   | Date/time picker (`DateTimePicker`)                   |
| `TimeField`        | Time entry field (`TimeField`)                        |

**Text & display**

| Component          | Description                                       |
| ------------------ | ------------------------------------------------- |
| `Typography`       | Compound text system (H1–H5, Body, Caption…)      |
| `Avatar`           | Image, initials, or icon avatar                   |
| `InitialsTile`     | Initials-only tile (`initials-tile`)              |
| `MetricCard`       | Stat card with icon, title, subtitle              |
| `Tag`              | Colored badge / label                             |
| `Chip`             | Compact chip / pill (`chip`)                      |
| `SectionHeader`    | Section title                                     |
| `TitleDescription` | Two-line label + description                      |
| `TitleWithIcon`    | Icon + title row                                  |
| `LucideIcon`       | Type-safe Lucide icon wrapper                     |
| `ImagePreview`     | Image with fullscreen preview                     |
| `ImageWithoutPreview` | Inline image display                           |

**Buttons & actions**

| Component           | Description                              |
| ------------------- | ---------------------------------------- |
| `Button`            | Primary, default, dashed, text variants  |
| `IconButton`        | Square icon-only button                  |
| `QuickActionButton` | List-row style CTA with icon             |

**Layout & containers**

| Component             | Description                                  |
| --------------------- | -------------------------------------------- |
| `Flex / Row / Column` | Flex layout primitives (`layout`)            |
| `Card`                | Elevated surface container                   |
| `Divider`             | Horizontal rule                              |
| `Header`              | Screen header with SafeAreaView              |
| `AppLayout`           | Full-screen layout wrapper (`app-layout`)    |
| `AppScrollLayout`     | Scrollable full-screen layout                |
| `SegmentedTabs`       | Pill-style tab selector                      |
| `GroupedMenu`         | Settings-style grouped list                  |
| `ListRow`             | Single list row with chevron                 |

**Modals & sheets**

| Component          | Description                        |
| ------------------ | ---------------------------------- |
| `BaseModal`        | Reusable modal container           |
| `BottomSheetModal` | Bottom sheet with handle           |
| `ModalHeader`      | Header for bottom sheets / modals  |
| `Alert`            | Alert dialog (`alert`)             |

**Lists & scaffolds**

| Component          | Description                                  |
| ------------------ | -------------------------------------------- |
| `ListPageScaffold` | Full list page with header and search        |
| `FlatListScaffold` | FlatList with pull-to-refresh & empty state  |
| `ThemedFlatList`   | FlatList with theme background               |
| `FlatListLoading`  | Loading shimmer for lists                    |
| `NoDataContainer`  | Empty state view                             |
| `SearchBar`        | Search bar (from `flat-list-scaffold`)       |
| `ItemCard`         | Generic product/item card                    |

**Loading & state**

| Component             | Description                            |
| --------------------- | -------------------------------------- |
| `SkeletonLoader`      | Animated placeholder                   |
| `SkeletonBox`         | Single shimmer box (`skeleton-box`)    |
| `OverlayLoader`       | Full-screen blocking loader            |
| `ScreenStateRenderer` | Loading / error / empty state switch   |

**POS & domain**

| Component          | Description                                        |
| ------------------ | ------------------------------------------------- |
| `pos`              | POS-specific components (`pos`)                    |
| `sync`             | Sync-status components (`sync`)                    |
| `useScanFeedback`  | Barcode-scan feedback hook (`use-scan-feedback`)  |

> **Casing note**: most component folders are kebab-case, but a few are PascalCase in the source
> (`DateTimePicker`, `ItemCard`, `Select`, `SkeletonLoader`, `TimeField`). New components should
> follow the kebab-case rule in §6; the PascalCase folders predate it.

### 4.2 Typography Component

```tsx
import { Typography } from "@nks/mobile-ui-components";

<Typography.H1>Heading 1</Typography.H1>
<Typography.H2>Heading 2</Typography.H2>
<Typography.H3>Heading 3</Typography.H3>
<Typography.H4>Heading 4</Typography.H4>
<Typography.H5>Heading 5</Typography.H5>
<Typography.Subtitle>Subtitle</Typography.Subtitle>
<Typography.Body>Body text</Typography.Body>
<Typography.Caption>Caption</Typography.Caption>
<Typography.Overline>OVERLINE</Typography.Overline>

// With color variant
<Typography.Body colorType={ColorType.primary}>Pink text</Typography.Body>
<Typography.Caption colorType={ColorType.danger}>Error note</Typography.Caption>

// With custom color
<Typography.Body color={theme.colorTextSecondary}>Muted text</Typography.Body>

// With weight
<Typography.Body weight="semiBold">Semi-bold body</Typography.Body>
```

### 4.3 Form Components

All form inputs integrate with **`react-hook-form`** (RHF). Always provide `name` and `control`:

```tsx
import { useForm } from "react-hook-form";
import { Input, CheckBox, Switch, PasswordInput } from "@nks/mobile-ui-components";

const { control } = useForm({ defaultValues: { email: "", agree: false } });

<Input
  name="email"
  control={control}
  label="Email Address"
  inputDataType="email"
  rules={{ required: "Email is required" }}
/>

<PasswordInput name="password" control={control} label="Password" />

<CheckBox name="agree" control={control} label="I agree to terms" />

<Switch name="notifications" control={control} label="Receive notifications" />
```

### 4.4 Layout Primitives

```tsx
import { Row, Column, Flex } from "@nks/mobile-ui-components";

// Row — horizontal flex
<Row gap={12} align="center" justify="space-between">
  <Text>Left</Text>
  <Text>Right</Text>
</Row>

// Column — vertical flex
<Column gap={8} padding={16}>
  <Text>Top</Text>
  <Text>Bottom</Text>
</Column>

// Flex — full control
<Flex direction="row" gap={8} flex={1} bg="primary">
  ...
</Flex>
```

---

## 5. Mandatory Styling Rules

### 5.1 Styled-Components Syntax

> ⚠️ **RULE**: All styled-components in `libs-mobile` **must** use the **template literal string syntax**.

```tsx
// ✅ CORRECT — Template literal syntax (mandatory in this library)
const HeaderContainer = styled(View)`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding-bottom: ${({ theme }) => theme.sizing.xSmall}px;
  padding-left: ${({ theme }) => theme.sizing.small}px;
  padding-right: ${({ theme }) => theme.sizing.small}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-bottom-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-bottom-color: ${({ theme }) => theme.colorBorder};
`;

// ✅ CORRECT — With custom typed props
const CardContainer = styled(View)<{ $active: boolean }>`
  background-color: ${({ $active, theme }) =>
    $active ? theme.colorPrimary : theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.regular}px;
  padding: ${({ theme }) => theme.sizing.medium}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
`;

// ✅ CORRECT — Wrapping a third-party or RN core component.
// Use theme.shadow.* instead of hand-writing shadow-color/offset/opacity/radius.
const StyledTouchable = styled(TouchableOpacity)`
  flex-direction: row;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.xSmall}px;
  ${({ theme }) => theme.shadow.md}
`;

// ❌ WRONG — Object literal syntax (only allowed in app-layer screens, not in libs-mobile)
const BadContainer = styled.View(({ theme }) => ({
  flex: 1,
  backgroundColor: theme.colorBgLayout,
}));

// ❌ WRONG — Inline styles
const Component = () => (
  <View style={{ backgroundColor: '#ff0000', padding: 16 }}>...</View>
);

// ❌ WRONG — Hardcoded values (always use theme tokens)
const BadSpacing = styled.View`
  padding: 16px; /* ❌ */
  border-radius: 8px; /* ❌ */
  background-color: #fff; /* ❌ */
`;
```

### 5.2 File Layout

Every component file **must** follow this structure:

```
1. Imports
2. Types / Interfaces
3. Component function (exported)
4. Styled-components (below the component function)
```

**Canonical example:**

```tsx
import React from 'react';
import { View } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@nks/mobile-theme';
import { Typography } from '../typography';

// ─── Types ──────────────────────────────────────────────────────────────
interface MyCardProps {
  title: string;
  subtitle?: string;
  onPress?: () => void;
}

// ─── Component ──────────────────────────────────────────────────────────
export const MyCard: React.FC<MyCardProps> = ({ title, subtitle, onPress }) => {
  const { theme } = useMobileTheme();

  return (
    <Container onPress={onPress} activeOpacity={0.8}>
      <Typography.Subtitle>{title}</Typography.Subtitle>
      {subtitle && (
        <Typography.Caption color={theme.colorTextSecondary}>
          {subtitle}
        </Typography.Caption>
      )}
    </Container>
  );
};

export default MyCard;

// ─── Styles (always below the component) ────────────────────────────────
const Container = styled.TouchableOpacity`
  flex-direction: column;
  padding: ${({ theme }) => theme.sizing.medium}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.regular}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
  gap: ${({ theme }) => theme.sizing.xSmall}px;
`;
```

---

## 6. Creating New Components

When told to create a new component targeting `libs-mobile/mobile-ui-components`:

### Step 1 — Create the folder

```
libs-mobile/mobile-ui-components/src/lib/<component-name>/
    index.tsx     ← Component code (types + JSX + styles)
    style.tsx     ← Only if variant maps are large (e.g. Button, IconButton)
```

### Step 2 — Apply the file template

```tsx
// libs-mobile/mobile-ui-components/src/lib/my-component/index.tsx
import React from 'react';
import { ViewProps } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme, ColorType } from '@nks/mobile-theme';

// --- Types ---
interface MyComponentProps extends ViewProps {
  // props ...
}

// --- Component (FIRST) ---
export const MyComponent: React.FC<MyComponentProps> = (props) => {
  const { theme } = useMobileTheme();
  return <Root>{/* JSX */}</Root>;
};

export default MyComponent;

// --- Styles (BELOW the component) ---
const Root = styled.View`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.regular}px;
  padding: ${({ theme }) => theme.sizing.medium}px;
`;
```

### Step 3 — Export from the barrel

Add the new component to `libs-mobile/mobile-ui-components/src/index.ts`:

```typescript
export * from './lib/my-component';
```

### Step 4 — Follow all styling rules

- ✅ Template literal styled-components
- ✅ Styles are placed **after** the component function
- ✅ All values come from `theme.*` tokens
- ✅ Custom props use `$`-prefix to avoid HTML attribute forwarding (e.g. `$variant`, `$size`)

---

## 7. Creating New Theme Tokens

When told to add new tokens to `libs-mobile/mobile-theme`:

### Adding a new color group

```typescript
// libs-mobile/mobile-theme/src/tokens/colors/light.ts

const teal: ColorValueType = {
  bg: '#e6fff9',
  bgActive: '#b3ffe8',
  bgSecondary: '#f0fffd',
  bgSecondaryActive: '#e6fff9',
  border: '#80ffd4',
  borderActive: '#40ffbe',
  active: '#008f70',
  main: '#00a86b', // ← The accent color
  onMain: '#ffffff',
  text: '#006645',
  textActive: '#005236',
};
```

Then register it in `ColorVariantKey` in `types.ts`, add to `ColorType` runtime object, and add to both `lightSemanticColors` and `darkSemanticColors`.

### Adding new flat tokens

```typescript
// libs-mobile/mobile-theme/src/tokens/colors/light.ts
export const lightColorTokens = {
  // ... existing tokens ...
  colorNewFeature: '#somevalue', // Add at end with a clear name
};
```

> **Rule**: Flat token names always start with `color` for colors, `fontSize` for font-sizes, `borderRadius` for radii, etc.

---

## 8. Rules Checklist

Before committing any code to `libs-mobile`:

- [ ] Imports are only from `@nks/mobile-theme` / `@nks/mobile-ui-components` (never sub-paths)
- [ ] Styled-components use **template literal** syntax
- [ ] Styled-components are **below** the component function in the file
- [ ] All spacing values use `theme.sizing.*` (or `theme.padding.*` / `theme.margin.*`)
- [ ] All colors use `theme.color.*` or flat `theme.colorXxx` tokens
- [ ] All border radii use `theme.borderRadius.*` (pill = `theme.borderRadius.full`, not `9999px`)
- [ ] All border widths use `theme.borderWidth.*` (modern names — **not** the `borderWidthThin` aliases)
- [ ] All shadows use `theme.shadow.*` — no hand-written `shadow-color: #000` / `elevation`
- [ ] All overlays/scrims use `theme.overlay.*` — no raw `rgba(...)`
- [ ] All brand gradients use `theme.gradient.*` — no literal color arrays
- [ ] No hardcoded color strings (no `"#ff0000"`, `"white"`, `"rgba(...)"`)
- [ ] No inline `style={{ }}` props
- [ ] Custom styled-component props are `$`-prefixed
- [ ] New component is exported from `libs-mobile/mobile-ui-components/src/index.ts`
- [ ] `ColorType.xxx` is used (not raw strings) for variant props
- [ ] Form inputs are wired to `react-hook-form` with `name` + `control`
- [ ] Theme toggling uses `setThemePreference(...)` — **not** `toggleTheme`/`setTheme`
