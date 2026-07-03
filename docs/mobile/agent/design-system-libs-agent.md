# CLAUDE.md — NKS Mobile Design System (@nks/mobile-theme + @nks/mobile-ui-components)

> Instructions for AI coding agents (Claude Code / Cursor / Copilot) writing ANY code inside
> `libs-mobile/mobile-theme` or `libs-mobile/mobile-ui-components`, and any app code that
> consumes them.
> **Stack (fixed):** `styled-components/native` (template-literal syntax) · a strongly-typed
> `NKSTheme` token object · `react-hook-form` for inputs.
> These are **rules, not suggestions.** A design system lives or dies on consistency — a single
> hardcoded `#fff` or object-syntax styled-component is a defect, not a style choice. When a
> rule conflicts with a request, surface the conflict and follow the rule unless the human
> explicitly overrides it.

---

## 0. The one-sentence mandate

**Every visual value comes from a `theme.*` token, every styled-component uses template-literal
syntax with styles placed below the component, and apps import only from the two package roots —
never a sub-path, never a raw literal, never an inline style.**

---

## 1. Import boundaries (non-negotiable)

- Apps and components import **only** from the package roots:
  `@nks/mobile-theme` and `@nks/mobile-ui-components`.
- **NEVER** import from a sub-path (`@nks/mobile-theme/src/tokens`, `.../lib/button`, etc.).
- Styling logic **never** lives in the app layer — it lives in `mobile-ui-components`. If an app
  screen needs a styled piece, either compose existing components or add a component to the lib.
- A new component is not "done" until it's exported from
  `libs-mobile/mobile-ui-components/src/index.ts` (barrel).

---

## 2. Styled-components syntax (hard rule)

- **Template-literal syntax ONLY** inside `libs-mobile`. Object-literal syntax
  (`styled.View(({theme}) => ({...}))`) is **forbidden** in the libs.
- **No inline `style={{ }}`** props. Ever.
- **No hardcoded values** — no `#ff0000`, `"white"`, `rgba(...)`, `16px`, `8px`, `9999px`,
  `shadow-color: #000`, `elevation: 4`, or literal gradient arrays. Every value is a token.
- **Custom props are `$`-prefixed** (`$active`, `$variant`, `$size`) so they don't forward to the
  native node. Type them: `styled(View)<{ $active: boolean }>`.
- Wrapping an RN core or third-party component uses `styled(Component)\`...\`` — and pulls
  effects from tokens (`${({theme}) => theme.shadow.md}`), never hand-written shadow props.

```tsx
// ✅ correct
const Card = styled(View)<{ $active: boolean }>`
  padding: ${({ theme }) => theme.sizing.medium}px;
  border-radius: ${({ theme }) => theme.borderRadius.regular}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  background-color: ${({ $active, theme }) =>
    $active ? theme.colorPrimary : theme.colorBgContainer};
  ${({ theme }) => theme.shadow.md}
`;

// ❌ forbidden: object syntax · inline style · hardcoded value · unprefixed custom prop
```

---

## 3. File layout (every component file, this order)

1. **Imports**
2. **Types / Interfaces**
3. **Component function (exported)** — FIRST
4. **Styled-components — BELOW the component function**

Styles always sit at the bottom of the file, after the component. Never above it, never in the
middle. Add a `// ─── Styles ───` divider comment if it aids readability.

Folder shape for a new component:
```
libs-mobile/mobile-ui-components/src/lib/<component-name>/
    index.tsx     # types + component + styles
    style.tsx     # ONLY if variant maps are large (e.g. Button, IconButton)
```
New folders are **kebab-case** (`my-component`). A few legacy folders are PascalCase
(`DateTimePicker`, `ItemCard`, `Select`, `SkeletonLoader`, `TimeField`) — those predate the rule;
do not add new PascalCase folders.

---

## 4. Token reference — use these exact names

You MUST use tokens, and you must use the correct token names. Do not invent names or reach for
raw values because you're unsure — the correct token exists below.

### 4.1 Colors — flat tokens (on `theme.*`)
`colorPrimary` (#1E3A8A, THE brand) · `colorPrimaryText` · `colorPrimaryBg` · `onColorPrimary`
· `colorPrimaryHover/Active/Border/BorderHover/BgHover/TextHover` · `colorBgContainer`
(card/surface) · `colorBgLayout` (page bg) · `colorText` · `colorTextSecondary` · `colorBorder`
· `colorBorderSecondary` · `colorSuccess` · `colorWarning` · `colorError` · `colorWhite`.

### 4.2 Colors — semantic map (on `theme.color.<variant>`)
Each variant exposes: `bg · bgActive · bgSecondary · bgSecondaryActive · border · borderActive ·
active · main · onMain · text · textActive`. Access e.g. `theme.color.primary.main`,
`theme.color.danger.border`, `theme.color.success.onMain`.
Variants (`ColorVariantKey`): `primary · secondary · success · danger · warning · blue · orange
· violet · green · red · grey · default`.
- **`danger` is an alias of `red`; `success` is an alias of `green`.** Use `danger`/`success`
  for semantic intent, `red`/`green` for palette decoration.
- For `variant` props, pass the **runtime `ColorType.xxx` object**, never a raw string:
  `variant={ColorType.primary}` — not `variant="primary"` (unless the prop type is literally `string`).
- `useColorVariant({ place })` where `place ∈ "main" | "background" | "border"` returns a flat
  `{ primary, danger, success, … }` map for that place.

### 4.3 Typography
`theme.fontSize.*`: `xxSmall`(10) `xSmall`(12) `small`(14) `regular`(16) `medium`(17) `large`(18)
`xLarge`(20) `xxLarge`(24) `h1`(32) `h2`(28) `h3`(24) `h4`(20) `h5`(18) `zero`(0) `step`(2).
`theme.fontFamily.poppins{Regular|SemiBold|Bold|Medium|Light|Thin|Italic}`.
`theme.fontWeight['400'|'600'|…]`.
Line height is **flat**: `theme.lineHeight` (a number), `theme.lineHeightSM/LG/Heading1…Heading5`.
`theme.lineHeight.base` does NOT exist on the theme (the nested object is a separate export).

### 4.4 Spacing & borders
`theme.sizing.*` (also `theme.padding.*` / `theme.margin.*`, same scale): `zero`(0) `xxSmall`(4)
`xSmall`(8) `small`(12) `medium`(16) `regular`(20) `large`(24) `xLarge`(32) `xxLarge`(48) `step`(4).
`theme.borderRadius.*`: `zero xxSmall xSmall small medium regular large xLarge xxLarge step` and
**`full`(9999) for pills/circles — use `theme.borderRadius.full`, never `9999px`.**
`theme.borderWidth.*` (modern names): `zero`(0) `mild`(0.5) `thin`(1) `light`(1.5) `medium`(3)
`bold`(4). **Do NOT use the deprecated `borderWidthThin/Mild/Light/Medium/Bold/Zero` aliases.**

### 4.5 Effects (mode-independent)
- Shadows: `theme.shadow.{none|sm|md|lg|top}` — interpolate directly:
  `${({theme}) => theme.shadow.md}`. Never write `shadow-color`/`elevation`.
- Overlays/scrims: `theme.overlay.{scrim|scrimSoft|onDark08|onDark04|onDark55|onLight06|onLight08}`.
  Never write a raw `rgba(...)`.
- Gradients (feed `expo-linear-gradient` `colors`): `theme.gradient.{brandHero|cta|ctaDisabled|
  ctaSuccess|dashboardHero|premiumCard|orbIndigo|orbViolet}`. Never a literal color array.
- Fixed brand surfaces: `theme.colorSplashBg` · `colorBrandSurface` · `colorAccentLavender` ·
  `colorTrustNote`.
- Fixed component dimensions not on the spacing scale: `theme.componentSizing.{ctaBtnHeight(54)|
  heroBrandIconSize(36)|…}`.

---

## 5. Theme provider & hooks

- Wrap the app once in `<MobileThemeProvider loadingFallback={…}>`.
- `useMobileTheme()` → `{ theme, isDarkMode, themePreference, setThemePreference, isThemeReady }`.
- **There is NO `toggleTheme` or `setTheme(isDark)`.** `isDarkMode` is read-only (derived).
  Toggle via `setThemePreference(isDarkMode ? "light" : "dark")`; values are `"light" | "dark" |
  "auto"`, persisted to AsyncStorage.
- Responsive: `useBreakpoint()` → `{ breakpoint, isPhone, isTablet, width }`;
  `useResponsiveValue({ phone, tablet, largeTablet })`; `useScaledSize(n)`; `useScaledFont(n)`.
  Breakpoints: phone 0 · tablet 600 · largeTablet 1024.

---

## 6. Consuming UI components (don't rebuild what exists)

Before building anything, check the catalogue — the component probably exists. Import from the
root and use it rather than hand-rolling a styled primitive in a screen.

- **Text is always `Typography`**, never a raw `<Text>`: `Typography.{H1..H5|Subtitle|Body|
  Caption|Overline}`, with `colorType={ColorType.x}` or `color={theme.colorX}` and
  `weight="semiBold"`.
- **Layout uses `Row` / `Column` / `Flex`** primitives (`gap`, `align`, `justify`, `padding`,
  `flex`, `bg`), not ad-hoc styled Views for simple flex.
- **Forms use the lib inputs wired to RHF** (`Input`, `PasswordInput`, `SearchInput`, `TextArea`,
  `MaskedInput`, `OtpInput`, `CheckBox`, `Switch`, `RadioGroup`) — always pass `name` + `control`.
- Selects: `SelectGeneric`, `ModalSelect`, `DateTimePicker`, `TimeField`.
- Display: `Avatar`, `MetricCard`, `Tag`, `Chip`, `SectionHeader`, `LucideIcon`, `ImagePreview`.
- Buttons: `Button`, `IconButton`, `QuickActionButton`.
- Containers/scaffolds: `Card`, `Divider`, `Header`, `AppLayout`, `AppScrollLayout`,
  `SegmentedTabs`, `GroupedMenu`, `ListRow`, `ListPageScaffold`, `FlatListScaffold`,
  `ThemedFlatList`, `NoDataContainer`.
- Modals/sheets: `BaseModal`, `BottomSheetModal`, `ModalHeader`, `Alert`.
- State/loading: `SkeletonLoader`, `SkeletonBox`, `OverlayLoader`, `ScreenStateRenderer`.

If a screen needs something not in the catalogue, **add a component to the lib** (following §3/§7),
don't style it inline in the app.

---

## 7. Creating a new component (the procedure)

1. Create `libs-mobile/mobile-ui-components/src/lib/<kebab-name>/index.tsx`.
2. Apply the file template: imports → types → **component (exported) first** → **styles below**.
3. All values from `theme.*` tokens; custom props `$`-prefixed and typed.
4. Export from the barrel: add `export * from './lib/<kebab-name>';` to
   `libs-mobile/mobile-ui-components/src/index.ts`.
5. If variant maps are large, split them into `style.tsx` in the same folder.

```tsx
import React from 'react';
import styled from 'styled-components/native';
import { useMobileTheme, ColorType } from '@nks/mobile-theme';
import { Typography } from '../typography';

// ─── Types ───
interface MyCardProps { title: string; subtitle?: string; onPress?: () => void; }

// ─── Component ───
export const MyCard: React.FC<MyCardProps> = ({ title, subtitle, onPress }) => {
  const { theme } = useMobileTheme();
  return (
    <Container onPress={onPress} activeOpacity={0.8}>
      <Typography.Subtitle>{title}</Typography.Subtitle>
      {subtitle && <Typography.Caption color={theme.colorTextSecondary}>{subtitle}</Typography.Caption>}
    </Container>
  );
};
export default MyCard;

// ─── Styles (below the component) ───
const Container = styled.TouchableOpacity`
  flex-direction: column;
  gap: ${({ theme }) => theme.sizing.xSmall}px;
  padding: ${({ theme }) => theme.sizing.medium}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.regular}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
`;
```

---

## 8. Creating a new theme token (the procedure)

- **New color group:** define a full `ColorValueType` object (all 11 slots: bg, bgActive,
  bgSecondary, bgSecondaryActive, border, borderActive, active, main, onMain, text, textActive)
  in BOTH `light.ts` and `dark.ts`; register the key in `ColorVariantKey` (`types.ts`), add it to
  the `ColorType` runtime object, and add to `lightSemanticColors` + `darkSemanticColors`.
- **New flat token:** add at the end of `lightColorTokens` (and dark) with a clear name.
- **Naming convention:** flat token names start with their category prefix — `color*` for colors,
  `fontSize*` for font sizes, `borderRadius*` for radii, `borderWidth*` for widths.
- Never add a token that duplicates an existing one; check first.

---

## 9. FORBIDDEN patterns (reject in review, refuse to write)

| Forbidden | Required replacement |
|---|---|
| object-syntax styled-component in libs | template-literal syntax |
| inline `style={{ }}` | styled-component with tokens |
| `#hex` / `"white"` / `rgba(...)` literal | `theme.color*` / `theme.color.*` / `theme.overlay.*` |
| `16px` / any hardcoded spacing | `theme.sizing.*` (or `padding`/`margin`) |
| `8px` / hardcoded radius, `9999px` | `theme.borderRadius.*`, pill = `theme.borderRadius.full` |
| `shadow-color: #000` / `elevation:` | `theme.shadow.*` |
| literal gradient color array | `theme.gradient.*` |
| deprecated `borderWidthThin` aliases | `theme.borderWidth.thin` etc. |
| unprefixed custom styled prop | `$`-prefixed (`$active`) |
| styles ABOVE the component | styles BELOW the component |
| sub-path import (`@nks/…/src/…`) | package-root import |
| raw `<Text>` for copy | `Typography.*` |
| ad-hoc styled View for simple flex | `Row` / `Column` / `Flex` |
| `variant="primary"` raw string | `variant={ColorType.primary}` |
| `toggleTheme` / `setTheme(isDark)` | `setThemePreference("light"\|"dark"\|"auto")` |
| `theme.lineHeight.base` | `theme.lineHeight` (flat number) |
| new PascalCase component folder | kebab-case folder |
| component not exported from barrel | add to `src/index.ts` |
| form input without `name` + `control` | wire to react-hook-form |

---

## 10. Definition of done (self-check before returning any code)

- [ ] Imports only from `@nks/mobile-theme` / `@nks/mobile-ui-components` roots (no sub-paths).
- [ ] Styled-components use **template-literal** syntax; **no** object syntax, **no** inline styles.
- [ ] Styles placed **below** the component function.
- [ ] Every color from `theme.color*` / `theme.color.*`; every spacing from `theme.sizing.*`;
      every radius from `theme.borderRadius.*` (pill = `full`); every width from
      `theme.borderWidth.*` (modern names); shadows `theme.shadow.*`; overlays `theme.overlay.*`;
      gradients `theme.gradient.*`.
- [ ] **Zero** hardcoded color/spacing/radius/shadow/gradient literals anywhere.
- [ ] Custom styled props are `$`-prefixed and typed.
- [ ] `variant` props use `ColorType.xxx`, not raw strings.
- [ ] Text uses `Typography.*`; simple flex uses `Row`/`Column`/`Flex`.
- [ ] Form inputs wired to RHF with `name` + `control`.
- [ ] Theme toggling uses `setThemePreference(...)` (no `toggleTheme`/`setTheme`).
- [ ] New component exported from `mobile-ui-components/src/index.ts`; folder is kebab-case.
- [ ] New tokens follow the naming prefix and exist in both light + dark.

If any item fails, the code is not done.

---

## 11. Things to refuse or flag

- Request to **hardcode a value** "just this once" (a color, spacing, shadow) → refuse; find or
  add the token.
- Request to **use object-syntax or inline styles** in libs → refuse; template literal + tokens.
- Request to **import from a sub-path** → refuse; use the package root (and if the export is
  missing, add it to the barrel).
- Request to **style a screen directly in the app layer** → flag; propose composing existing
  components or adding one to the lib.
- Request for **`toggleTheme`** → flag; it doesn't exist — use `setThemePreference`.
- Request to **rebuild a component that exists** in the catalogue → flag; use the existing one.
- Request to add a **PascalCase component folder** → flag; kebab-case for new components.

When flagging: state the rule, the concrete consistency/maintenance risk, and the correct
token/component to use — then implement the correct version unless explicitly overridden.

---

*This file governs the design-system layer only (tokens + shared components). Form BEHAVIOR
(validation, submit, timing) lives in the forms agent; navigation lives in the router agent;
these components are the visual building blocks those layers consume. When this file changes,
review lib code for compliance within one sprint — the point of a canonical token system is that
it stays canonical.*
