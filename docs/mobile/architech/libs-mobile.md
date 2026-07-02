# NKS Mobile Libraries — Developer Guide

> **Scope**: This document governs all code written inside `libs-mobile/theme` and `libs-mobile/mobile-ui-components`.
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
   - [ThemeProvider & Hooks](#35-themeprovider--hooks)
4. [@nks/mobile-ui-components — UI Component Library](#4-nksmobile-ui--ui-component-library)
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
| `@nks/mobile-theme`         | `libs-mobile/theme`                | Design tokens, ThemeProvider, and hooks |
| `@nks/mobile-ui-components` | `libs-mobile/mobile-ui-components` | All shared UI components                |

Every app in the monorepo (`apps/nks-mobile`, etc.) imports **only** from these two packages. Styling logic must never live in the app layer.

---

## 2. Monorepo Structure

```
nks/
├── apps/
│   └── nks-mobile/          ← Expo app (consumers only)
└── libs-mobile/
    ├── theme/               ← @nks/mobile-theme
    │   └── src/
    │       ├── tokens/      ← Pure data: colors, typography, spacing
    │       ├── types/       ← styled.d.ts type augmentation
    │       ├── ThemeProvider.tsx
    │       └── index.ts     ← Public API
    └── ui/                  ← @nks/mobile-ui-components
        └── src/
            ├── lib/         ← One folder per component
            └── index.ts     ← Public barrel export
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
│   ├── types.ts      ← ColorValueType, ColorVariantKey, ColorType
│   ├── light.ts      ← Light mode semantic colors + flat tokens
│   └── dark.ts       ← Dark mode semantic colors + flat tokens
├── typography.ts     ← FontSize, FontFamily, FontWeight, LineHeight
├── spacing.ts        ← Sizing, Spacing (margin/padding), BorderRadius, BorderWidth
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

| Key         | Usage                                 |
| ----------- | ------------------------------------- |
| `primary`   | Brand color — `#df005c`               |
| `secondary` | Neutral slate                         |
| `success`   | Green — confirmations, success states |
| `danger`    | Red — errors, destructive actions     |
| `warning`   | Amber — warnings, caution             |
| `blue`      | Info, links                           |
| `orange`    | Extended palette                      |
| `violet`    | Extended palette                      |
| `green`     | Extended palette                      |
| `red`       | Extended palette                      |
| `grey`      | Disabled, placeholder                 |
| `default`   | General text, neutral elements        |

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
theme.colorPrimary; // Brand primary color
theme.colorBgContainer; // Card / surface background
theme.colorBgLayout; // Page / screen background
theme.colorText; // Primary body text
theme.colorTextSecondary; // Muted / secondary text
theme.colorBorder; // Default border
theme.colorBorderSecondary; // Dividers, subtle borders
theme.colorSuccess; // #00a86b
theme.colorWarning; // #f59e0b
theme.colorError; // #fb2c36
theme.colorWhite; // #ffffff
theme.onColorPrimary; // Text on primary button (white in light mode)
```

#### Accessing Semantic Colors in Components

```typescript
// Via the theme.color map:
theme.color.primary.bg; // Light pink background
theme.color.primary.main; // #df005c
theme.color.danger.border; // Red border
theme.color.success.onMain; // White (text on green button)

// Via the useColorVariant hook:
const mainColors = useColorVariant({ place: 'main' });
mainColors.primary; // → "#df005c"
mainColors.success; // → "#00a86b"
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

// Font families (all Poppins variants)
theme.fontFamily.poppinsRegular;
theme.fontFamily.poppinsSemiBold;
theme.fontFamily.poppinsBold;
theme.fontFamily.poppinsMedium;
theme.fontFamily.poppinsLight;
theme.fontFamily.poppinsThin;
theme.fontFamily.poppinsItalic;
```

### 3.4 Spacing & Border Tokens

```typescript
// Sizing — same scale for margin, padding, gap
theme.sizing.xxSmall; // 4
theme.sizing.xSmall; // 8
theme.sizing.small; // 12
theme.sizing.medium; // 16
theme.sizing.regular; // 20
theme.sizing.large; // 24
theme.sizing.xLarge; // 32
theme.sizing.xxLarge; // 48

// Border radius
theme.borderRadius.xSmall; // 2
theme.borderRadius.small; // 4
theme.borderRadius.medium; // 6
theme.borderRadius.regular; // 8
theme.borderRadius.large; // 10
theme.borderRadius.xLarge; // 12

// Border width
theme.borderWidth.mild; // 0.5
theme.borderWidth.thin; // 1
theme.borderWidth.light; // 1.5
theme.borderWidth.medium; // 3
theme.borderWidth.bold; // 4
```

> **Rule**: Never hardcode spacing numbers. Always use `theme.sizing.*` or `theme.borderRadius.*`.

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
  isDarkMode, // boolean
  toggleTheme, // () => Promise<void>
  setTheme, // (isDark: boolean) => Promise<void>
  isThemeReady, // boolean — false until AsyncStorage resolves
} = useMobileTheme();
```

#### `useColorVariant()`

```typescript
// Returns a flat map of all variant colors for a specific "place"
const mainColors = useColorVariant({ place: 'main' }); // { primary, danger, ... }
const bgColors = useColorVariant({ place: 'background' }); // { primary, danger, ... }
const borderColors = useColorVariant({ place: 'border' });
```

---

## 4. @nks/mobile-ui-components — UI Component Library

### 4.1 Component Catalogue

| Component             | Import                      | Description                                  |
| --------------------- | --------------------------- | -------------------------------------------- |
| `Button`              | `@nks/mobile-ui-components` | Primary, default, dashed, text variants      |
| `IconButton`          | `@nks/mobile-ui-components` | Square icon-only button                      |
| `Input`               | `@nks/mobile-ui-components` | RHF-controlled text input with label & error |
| `PasswordInput`       | `@nks/mobile-ui-components` | Input with show/hide toggle                  |
| `SearchInput`         | `@nks/mobile-ui-components` | Search bar with icon                         |
| `TextArea`            | `@nks/mobile-ui-components` | Multi-line input                             |
| `CheckBox`            | `@nks/mobile-ui-components` | Controlled or RHF-integrated checkbox        |
| `Switch`              | `@nks/mobile-ui-components` | Animated toggle, uncontrolled or RHF         |
| `RadioGroup`          | `@nks/mobile-ui-components` | Group of radio options                       |
| `Typography`          | `@nks/mobile-ui-components` | Compound text system (H1–H5, Body, Caption…) |
| `Avatar`              | `@nks/mobile-ui-components` | Image, initials, or icon avatar              |
| `MetricCard`          | `@nks/mobile-ui-components` | Stat card with icon, title, subtitle         |
| `QuickActionButton`   | `@nks/mobile-ui-components` | List-row style CTA with icon                 |
| `Card`                | `@nks/mobile-ui-components` | Elevated surface container                   |
| `Divider`             | `@nks/mobile-ui-components` | Horizontal rule                              |
| `Tag`                 | `@nks/mobile-ui-components` | Colored badge / label                        |
| `SectionHeader`       | `@nks/mobile-ui-components` | Section title                                |
| `TitleDescription`    | `@nks/mobile-ui-components` | Two-line label + description                 |
| `TitleWithIcon`       | `@nks/mobile-ui-components` | Icon + title row                             |
| `LucideIcon`          | `@nks/mobile-ui-components` | Type-safe Lucide icon wrapper                |
| `Flex / Row / Column` | `@nks/mobile-ui-components` | Flex layout primitives                       |
| `Header`              | `@nks/mobile-ui-components` | Screen header with SafeAreaView              |
| `ModalHeader`         | `@nks/mobile-ui-components` | Header for bottom sheets / modals            |
| `BaseModal`           | `@nks/mobile-ui-components` | Reusable modal container                     |
| `BottomSheetModal`    | `@nks/mobile-ui-components` | Bottom sheet with handle                     |
| `ModalSelect`         | `@nks/mobile-ui-components` | Single / multi-select modal                  |
| `FlatListScaffold`    | `@nks/mobile-ui-components` | FlatList with pull-to-refresh & empty state  |
| `ThemedFlatList`      | `@nks/mobile-ui-components` | FlatList with theme background               |
| `FlatListLoading`     | `@nks/mobile-ui-components` | Loading shimmer for lists                    |
| `NoDataContainer`     | `@nks/mobile-ui-components` | Empty state view                             |
| `ListPageScaffold`    | `@nks/mobile-ui-components` | Full list page with header and search        |
| `AppLayout`           | `@nks/mobile-ui-components` | Full-screen layout wrapper                   |
| `ItemCard`            | `@nks/mobile-ui-components` | Generic product/item card                    |
| `GroupedMenu`         | `@nks/mobile-ui-components` | Settings-style grouped list                  |
| `ListRow`             | `@nks/mobile-ui-components` | Single list row with chevron                 |
| `SkeletonLoader`      | `@nks/mobile-ui-components` | Animated placeholder                         |
| `ImagePreview`        | `@nks/mobile-ui-components` | Image with fullscreen preview                |
| `ImageWithoutPreview` | `@nks/mobile-ui-components` | Inline image display                         |
| `SegmentedTabs`       | `@nks/mobile-ui-components` | Pill-style tab selector                      |
| `SelectGeneric`       | `@nks/mobile-ui-components` | Generic dropdown select                      |
| `BaseSelectItem`      | `@nks/mobile-ui-components` | Single item in a select list                 |

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
  padding-bottom: ${({ theme }) => theme.padding.xSmall}px;
  padding-left: ${({ theme }) => theme.padding.small}px;
  padding-right: ${({ theme }) => theme.padding.small}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-bottom-width: ${({ theme }) => theme.borderWidth.borderWidthThin}px;
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

// ✅ CORRECT — Wrapping a third-party or RN core component
const StyledTouchable = styled(TouchableOpacity)`
  flex-direction: row;
  align-items: center;
  gap: 8px;
  elevation: 2;
  shadow-color: #000;
  shadow-offset: 0px 2px;
  shadow-opacity: 0.1;
  shadow-radius: 4px;
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

When told to add new tokens to `libs-mobile/theme`:

### Adding a new color group

```typescript
// libs-mobile/theme/src/tokens/colors/light.ts

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
// libs-mobile/theme/src/tokens/colors/light.ts
export const lightColorTokens = {
  // ... existing tokens ...
  colorNewFeature: '#somevalue', // Add at end with a clear name
};
```

> **Rule**: Flat token names always start with `color` for colors, `fontSize` for font-sizes, `borderRadius` for radii, etc.

---

## 8. Rules Checklist

Before committing any code to `libs-mobile`:

- [ ] Imports are only from `@nks/mobile-theme` (never sub-paths)
- [ ] Styled-components use **template literal** syntax
- [ ] Styled-components are **below** the component function in the file
- [ ] All spacing values use `theme.sizing.*`
- [ ] All colors use `theme.color.*` or flat `theme.colorXxx` tokens
- [ ] All border radii use `theme.borderRadius.*`
- [ ] All border widths use `theme.borderWidth.*`
- [ ] No hardcoded color strings (no `"#ff0000"`, `"white"`, `"rgba(...)"`)
- [ ] No inline `style={{ }}` props
- [ ] Custom styled-component props are `$`-prefixed
- [ ] New component is exported from `libs-mobile/mobile-ui-components/src/index.ts`
- [ ] `ColorType.xxx` is used (not raw strings) for variant props
- [ ] Form inputs are wired to `react-hook-form` with `name` + `control`
