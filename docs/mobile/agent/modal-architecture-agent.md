# Modal & Bottom Sheet Architecture — Ayphen Retail Mobile

> **App:** Ayphen Retail (React Native · Expo · Expo Router · offline-first POS)
> **Stack:** `react-native-reanimated` · `react-native-gesture-handler` ·
> `react-native-safe-area-context` · `@nks/mobile-theme` · `@nks/mobile-ui-components`
> **Status:** Canonical. This supersedes any ad-hoc modal or sheet. It defines the boundary
> between **router modals** (destinations) and **imperative bottom sheets** (ephemeral in-place
> UI), and the production-ready shell for the latter — corrected for UI-thread animation, a
> single snap-state source of truth, wired gesture handoff, tokenized styling, guaranteed
> unlock, Android back, and RBAC/subscription gating.

---

## Table of Contents

1. [The Two Modal Systems — and When to Use Which](#1-the-two-modal-systems--and-when-to-use-which)
2. [The Boundary Rule (memorize this)](#2-the-boundary-rule-memorize-this)
3. [Architecture Overview](#3-architecture-overview)
4. [Non-Negotiable Design Rules](#4-non-negotiable-design-rules)
5. [Dependencies & Entry Point](#5-dependencies--entry-point)
6. [File Structure](#6-file-structure)
7. [Core Types & Config](#7-core-types--config)
8. [Context, Hook & the `runLocked` Guarantee](#8-context-hook--the-runlocked-guarantee)
9. [Content Model — Component + Props, Never a Rendered Element](#9-content-model--component--props-never-a-rendered-element)
10. [Single-Snap Shell (corrected)](#10-single-snap-shell-corrected)
11. [Multi-Snap Shell (corrected gesture handoff)](#11-multi-snap-shell-corrected-gesture-handoff)
12. [Android Back, Backdrop & Dismissal](#12-android-back-backdrop--dismissal)
13. [Keyboard Strategy](#13-keyboard-strategy)
14. [Theming — Tokens Only](#14-theming--tokens-only)
15. [RBAC & Subscription Gating at the Shell](#15-rbac--subscription-gating-at-the-shell)
16. [Stacked Sheets vs Wizards](#16-stacked-sheets-vs-wizards)
17. [Snap Point Reference](#17-snap-point-reference)
18. [Multi-Snap Behaviour Table](#18-multi-snap-behaviour-table)
19. [All Scenarios (config recipes)](#19-all-scenarios-config-recipes)
20. [Reusable Content Components](#20-reusable-content-components)
21. [Accessibility](#21-accessibility)
22. [Performance](#22-performance)
23. [Dos & Don'ts](#23-dos--donts)
24. [Common Mistakes & Fixes](#24-common-mistakes--fixes)
25. [Decision Guide](#25-decision-guide)
26. [Migration from the Old Sheet](#26-migration-from-the-old-sheet)

---

## 1. The Two Modal Systems — and When to Use Which

The app has **two** modal mechanisms. Using the wrong one is the most common architectural
mistake, so this section comes first.

| | **Router modals** | **Imperative bottom sheets** |
|---|---|---|
| Mechanism | Expo Router `(modals)` group, `presentation:'modal'` | `useBottomSheet().open(config)` |
| Identity | A **route** with a URL | Pure React state, no URL |
| Back button | Handled by the router | Handled by the shell (`BackHandler`) |
| Deep-linkable | **Yes** | No |
| Survives `router.push` | Participates in the stack | Must be closed first (or bound — §12) |
| Use for | **Destinations** | **Ephemeral in-place UI** |
| Examples | step-up MFA, store-switcher, location-picker, subscription-wall, full-screen scanner | pickers, action menus, confirmations, quick-add forms, detail peeks |

**Why two exist:** a step-up MFA screen is a *destination* — it can be deep-linked, it must
survive navigation, and back should behave like navigation. A GST-rate picker is *ephemeral* —
it never needs a URL, it's a momentary choice, and building it as a route is overkill. Forcing
everything into one system produces either heavyweight pickers or un-deep-linkable destinations.

---

## 2. The Boundary Rule (memorize this)

> **If it needs a URL, survives navigation, or can be deep-linked → router modal.**
> **If it's an ephemeral in-place choice that never needs a URL → bottom sheet.**

Concretely:
- **Router modal (`app/(app)/(modals)/…`):** step-up, store-switcher, location-picker,
  subscription-wall, barcode-scanner (full-screen destination), any modal a notification or deep
  link must be able to open.
- **Bottom sheet (`useBottomSheet`):** tax-rate/category/unit pickers, customer/product search
  pickers, action menus, delete/discard confirmations, quick-add forms, detail peeks,
  half→full lists.

When unsure, ask: *"Would I ever want to deep-link to this, or have back navigate to it?"* Yes →
router modal. No → sheet. **Write the choice down in the PR description** so the boundary stays
clean; the failure mode is two systems drifting into overlap.

Router modals follow the **Expo Router architecture doc** (guards, `<Redirect>`, `dismissAll`).
This document governs the **bottom sheet** system from here on.

---

## 3. Architecture Overview

```
App entry
  └── GestureHandlerRootView              ← outermost (required by RNGH)
        └── SafeAreaProvider
              └── MobileThemeProvider
                    └── BottomSheetProvider     ← wraps entire app, above navigation
                          ├── <Stack /> (Expo Router — screens + router modals)
                          └── BottomSheetShell  ← rendered by provider when a sheet is open
                                ├── SingleSnapShell  ← fixed-height scenarios
                                └── MultiSnapShell   ← half → full scroll scenarios
                                      └── <Component {...props} />   ← your content

Call from anywhere:
  const sheet = useBottomSheet();
  sheet.open({ snapPoint:'md', title:'Select unit', Component: UnitPicker, props:{...} });
  sheet.close();
  sheet.runLocked(async () => { await save(); });   // auto preventClose + guaranteed unlock
```

**Data flow on open:** caller `open(config)` → provider stores config → shell mounts → open
animation (UI thread) → content mounts → user interacts → content calls `close()` (or
`runLocked` completes) → close animation → shell unmounts → `onClose` fires.

**`BottomSheetProvider` must sit ABOVE the navigation stack**, not inside it — otherwise sheets
render behind the nav header (§24).

---

## 4. Non-Negotiable Design Rules

1. **Content is a component reference + props, never a rendered element** (§9). Storing JSX in
   context state causes remount-on-`updateConfig` flicker.
2. **The shell owns** animation, drag, backdrop, keyboard, back button, accessibility. **Content
   owns** data, logic, submission.
3. **`close()` is always called from content**, never from shell internals based on business
   logic.
4. **Snap animations stay on the UI thread.** Never bounce a `withSpring` through `runOnJS`.
5. **One source of truth for snap state** — a shared value; React state is a projection via
   `useAnimatedReaction`.
6. **All styling comes from `theme.*` tokens** (§14). No `rgba()`, no hardcoded px, no inline
   `style` for values that have tokens. This is a lib component; it follows lib rules.
7. **`preventClose` is only ever set via `runLocked`** so it can't leak and trap the user (§8).
8. **Android back and backdrop both go through Gesture Handler / `BackHandler`**, respecting
   `preventClose`.
9. **Write sheets respect RBAC + subscription** the same as any other write (§15).

---

## 5. Dependencies & Entry Point

```bash
npx expo install react-native-reanimated react-native-gesture-handler react-native-safe-area-context
```
```js
// babel.config.js
module.exports = { presets: ['babel-preset-expo'], plugins: ['react-native-reanimated/plugin'] };
```
```tsx
// app/_layout.tsx — GestureHandlerRootView MUST be outermost; provider ABOVE the Stack
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { MobileThemeProvider } from '@nks/mobile-theme';
import { BottomSheetProvider } from '@/context/BottomSheetContext';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <MobileThemeProvider>
          <BottomSheetProvider>
            <Stack />
          </BottomSheetProvider>
        </MobileThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
```

---

## 6. File Structure

```
src/
  context/
    BottomSheetContext.tsx        ← types, provider, hook, runLocked
  components/BottomSheet/
    BottomSheetShell.tsx          ← routes single vs multi
    SingleSnapShell.tsx           ← fixed-height shell (corrected)
    MultiSnapShell.tsx            ← half→full shell (corrected handoff)
    SheetSkeleton.tsx             ← loading state
    SheetError.tsx                ← error state
    SheetListItem.tsx             ← standard picker row
    SheetSearchBar.tsx            ← auto-focus search
    SheetConfirmActions.tsx       ← confirm/cancel pair
    useSheetStyles.ts             ← token → style resolver (theming)
    index.ts
```

---

## 7. Core Types & Config

```typescript
export type SnapPoint = 'sm' | 'md' | 'lg' | 'full';
// sm 35% · md 55% · lg 80% · full 100% (heights read live from window — §M1 fix)

export interface BottomSheetConfig<P = any> {
  // ── Content (component + props — NEVER a rendered element) ──
  Component: React.ComponentType<P>;
  props?: P;

  // ── Snap ──
  snapPoint?: SnapPoint;             // single-snap; default 'md'
  multiSnap?: boolean;               // enables half→full
  initialSnap?: 'half' | 'full';     // multi-snap only; default 'half'

  // ── Header ──
  title?: string;
  subtitle?: string;

  // ── Behaviour ──
  showHandle?: boolean;              // default true
  closeOnBackdrop?: boolean;         // default true
  preventClose?: boolean;            // MANAGED — set only via runLocked; default false
  reduceMotion?: boolean;            // respect AccessibilityInfo; default auto

  // ── Gating (§15) ──
  requirePermission?: { entity: string; action: 'view'|'create'|'edit'|'delete' };
  requiresWrite?: boolean;           // routes to subscription wall if account lapsed

  // ── Callbacks ──
  onOpen?: () => void;               // after open animation
  onClose?: () => void;              // after close animation
}
```

---

## 8. Context, Hook & the `runLocked` Guarantee

```typescript
// context/BottomSheetContext.tsx
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { BottomSheetShell } from '@/components/BottomSheet';

interface BottomSheetContextValue {
  open: <P>(config: BottomSheetConfig<P>) => void;
  close: () => void;
  updateConfig: (partial: Partial<BottomSheetConfig>) => void;
  /** Sets preventClose for the duration of fn and ALWAYS clears it (finally). */
  runLocked: <T>(fn: () => Promise<T>) => Promise<T>;
  isOpen: boolean;
}

const Ctx = createContext<BottomSheetContextValue | null>(null);

export function BottomSheetProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [config, setConfig]   = useState<BottomSheetConfig | null>(null);
  const configRef             = useRef<BottomSheetConfig | null>(null); // gestures read latest

  const open = useCallback(<P,>(cfg: BottomSheetConfig<P>) => {
    configRef.current = cfg; setConfig(cfg); setVisible(true);
  }, []);

  const close = useCallback(() => {
    if (configRef.current?.preventClose) return;   // locked → ignore
    setVisible(false);                              // onClose fires after anim (shell → runOnJS)
  }, []);

  const updateConfig = useCallback((partial: Partial<BottomSheetConfig>) => {
    setConfig(prev => (prev ? { ...prev, ...partial } : prev));
    if (configRef.current) configRef.current = { ...configRef.current, ...partial };
  }, []);

  // The ONLY way to set preventClose. Guarantees unlock even if fn throws.
  const runLocked = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    updateConfig({ preventClose: true });
    try { return await fn(); }
    finally { updateConfig({ preventClose: false }); }
  }, [updateConfig]);

  return (
    <Ctx.Provider value={{ open, close, updateConfig, runLocked, isOpen: visible }}>
      {children}
      {visible && config && (
        <BottomSheetShell
          config={config}
          configRef={configRef}
          onAnimatedClose={() => { setVisible(false); config.onClose?.(); }}
        />
      )}
    </Ctx.Provider>
  );
}

export function useBottomSheet() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useBottomSheet must be used inside BottomSheetProvider');
  return ctx;
}
```

**Why `runLocked` exists:** manual `preventClose` toggling split across success/error paths is
the #1 way to permanently trap a user (locked sheet + no handle + no backdrop + no back). A
`try/finally` makes the unlock impossible to leak. **Never expose manual `preventClose` as the
primary API** — content calls `sheet.runLocked(async () => { await createCustomer(v); })`.

---

## 9. Content Model — Component + Props, Never a Rendered Element

Storing a rendered element (`content: <Foo/>`) in context state means any provider re-render (or
`updateConfig`) can hand the shell a new element identity → **content remounts**, losing form
state, scroll, focus, and re-running effects. Storing a **component reference + props** fixes this
structurally.

```tsx
// BottomSheetShell renders:
const { Component, props } = config;
return <Component {...(props ?? {})} />;

// ✅ caller
sheet.open({ snapPoint:'md', title:'GST rate', Component: TaxRatePicker, props:{ rates, selected, onChange } });

// ❌ forbidden — inline element, remounts on any config change
sheet.open({ content: <TaxRatePicker rates={rates} /> });
```

Props that are callbacks should still be stable (`useCallback`) so the child doesn't re-render,
but content **identity** no longer depends on the caller remembering that.

---

## 10. Single-Snap Shell (corrected)

Fixed height, no scroll-expand. Corrections vs the naive version: **live dimensions**,
**tokenized styling**, **UI-thread close**, **Gesture.Tap backdrop**, **BackHandler**,
**reduce-motion**.

```tsx
// components/BottomSheet/SingleSnapShell.tsx
import React, { useEffect } from 'react';
import { BackHandler, KeyboardAvoidingView, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMobileTheme, Typography } from '@nks/mobile-ui-components';
import type { BottomSheetConfig } from '@/context/BottomSheetContext';

const SPRING = { damping: 20, stiffness: 200, mass: 0.8 };
const CLOSE_DISTANCE = 80, CLOSE_VELOCITY = 600;
const RATIO: Record<string, number> = { sm: 0.35, md: 0.55, lg: 0.8, full: 1 };

export function SingleSnapShell({ config, configRef, onAnimatedClose }: Props) {
  const { theme } = useMobileTheme();
  const insets = useSafeAreaInsets();
  const { height: SCREEN_H } = useWindowDimensions();          // live — survives rotation (M1)
  const snapHeight = SCREEN_H * (RATIO[config.snapPoint ?? 'md']);

  const translateY = useSharedValue(snapHeight);              // start offscreen (no flicker)
  const backdrop   = useSharedValue(0);

  useEffect(() => {
    translateY.value = withSpring(0, SPRING, () => { if (config.onOpen) runOnJS(config.onOpen)(); });
    backdrop.value   = withTiming(1, { duration: config.reduceMotion ? 0 : 250 });
  }, []);

  // Close entirely on the UI thread; only the JS callback crosses via runOnJS.
  const animatedClose = () => {
    'worklet';
    translateY.value = withSpring(snapHeight, SPRING, (done) => { if (done) runOnJS(onAnimatedClose)(); });
    backdrop.value   = withTiming(0, { duration: 200 });
  };
  const jsClose = () => { if (!configRef.current?.preventClose) animatedClose(); };

  // Android hardware back — respects preventClose (H2)
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (configRef.current?.preventClose) return false;
      jsClose(); return true;                                  // consume
    });
    return () => sub.remove();
  }, []);

  const dragStart = useSharedValue(0);
  const drag = Gesture.Pan()
    .onStart(() => { 'worklet'; dragStart.value = translateY.value; })
    .onUpdate((e) => { 'worklet'; translateY.value = Math.max(0, dragStart.value + e.translationY); })
    .onEnd((e) => {
      'worklet';
      const shouldClose = e.translationY > CLOSE_DISTANCE || e.velocityY > CLOSE_VELOCITY;
      if (shouldClose && !configRef.current?.preventClose) animatedClose();
      else translateY.value = withSpring(0, SPRING);          // rubber-band back
    })
    .enabled(!config.preventClose);

  const backdropTap = Gesture.Tap().onEnd(() => {
    'worklet';
    if (config.closeOnBackdrop !== false && !configRef.current?.preventClose) animatedClose();
  });

  const sheetStyle    = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <GestureDetector gesture={backdropTap}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay.scrim }, backdropStyle]} />
      </GestureDetector>

      <Animated.View
        accessibilityViewIsModal
        accessibilityLabel={config.title ?? 'Bottom sheet'}
        style={[styles.sheet, {
          height: snapHeight, backgroundColor: theme.colorBgContainer,
          borderTopLeftRadius: theme.borderRadius.xLarge, borderTopRightRadius: theme.borderRadius.xLarge,
          paddingBottom: insets.bottom,
        }, sheetStyle]}
      >
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          {config.showHandle !== false && (
            <GestureDetector gesture={drag}>
              <View style={{ alignItems: 'center', paddingVertical: theme.sizing.xSmall }}
                    accessibilityRole="adjustable" accessibilityLabel="Drag to close" accessibilityHint="Drag down to dismiss">
                <View style={{ width: 36, height: 4, borderRadius: theme.borderRadius.step, backgroundColor: theme.colorBorder }} />
              </View>
            </GestureDetector>
          )}
          {(config.title || config.subtitle) && (
            <View style={{ paddingHorizontal: theme.sizing.medium, paddingBottom: theme.sizing.small,
                           borderBottomWidth: theme.borderWidth.mild, borderBottomColor: theme.colorBorderSecondary }}>
              {config.title && <Typography.H5>{config.title}</Typography.H5>}
              {config.subtitle && <Typography.Caption color={theme.colorTextSecondary}>{config.subtitle}</Typography.Caption>}
            </View>
          )}
          <View style={{ flex: 1 }}><config.Component {...(config.props ?? {})} /></View>
        </KeyboardAvoidingView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, overflow: 'hidden' },
});
```

> Note: `StyleSheet` is used only for **layout** (position/flex); every **value** (radius,
> spacing, colors, border widths) comes from `theme.*`. That satisfies the design-system rule
> while keeping Reanimated ergonomics.

---

## 11. Multi-Snap Shell (corrected gesture handoff)

Half → full on scroll. The three corrections that make it actually work:

1. **UI-thread snapping** — `snapTo` is a worklet; only `setCurrentSnap` (React state) crosses via
   `runOnJS`.
2. **Single snap-state source** — a shared value `snapSV`; React `currentSnap` derives from it via
   `useAnimatedReaction`. No dual-ref desync.
3. **Wired handoff** — `simultaneousWithExternalGesture(scrollRef)` with a real ref (the no-arg
   call is a no-op and the headline feature silently fails without this).

```tsx
// components/BottomSheet/MultiSnapShell.tsx  (key parts)
import React, { useEffect, useRef, useState } from 'react';
import { BackHandler, ScrollView, useWindowDimensions } from 'react-native';
import Animated, { runOnJS, useAnimatedReaction, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

const SPRING = { damping: 22, stiffness: 220, mass: 0.9 };
const DIST = 60, VEL = 600;

export function MultiSnapShell({ config, configRef, onAnimatedClose }: Props) {
  const { height: SCREEN_H } = useWindowDimensions();
  const SNAP_HALF = SCREEN_H * 0.5, SNAP_FULL = SCREEN_H * 0.92;
  const yHalf = SCREEN_H - SNAP_HALF, yFull = SCREEN_H - SNAP_FULL;

  const translateY = useSharedValue(SCREEN_H);
  const backdrop   = useSharedValue(0);
  const snapSV     = useSharedValue<'half' | 'full'>(config.initialSnap ?? 'half'); // SINGLE source
  const scrollAtTop = useSharedValue(true);
  const [currentSnap, setCurrentSnap] = useState<'half' | 'full'>(config.initialSnap ?? 'half');
  const scrollRef = useRef<ScrollView>(null);

  // React state is a PROJECTION of the shared value (drives scrollEnabled) — no desync.
  useAnimatedReaction(() => snapSV.value, (v, prev) => { if (v !== prev) runOnJS(setCurrentSnap)(v); });

  useEffect(() => {
    translateY.value = withSpring(config.initialSnap === 'full' ? yFull : yHalf, SPRING);
    backdrop.value   = withTiming(1, { duration: 250 });
  }, []);

  const snapTo = (target: 'half' | 'full' | 'close') => {
    'worklet';
    if (target === 'close') {
      translateY.value = withSpring(SCREEN_H, SPRING, (d) => { if (d) runOnJS(onAnimatedClose)(); });
      backdrop.value = withTiming(0, { duration: 200 }); return;
    }
    snapSV.value = target;                                    // updates source; reaction updates React
    translateY.value = withSpring(target === 'full' ? yFull : yHalf, SPRING);
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (configRef.current?.preventClose) return false;
      snapTo('close'); return true;
    });
    return () => sub.remove();
  }, []);

  const dragStart = useSharedValue(0);
  const handleGesture = Gesture.Pan()
    .onStart(() => { 'worklet'; dragStart.value = translateY.value; })
    .onUpdate((e) => { 'worklet'; translateY.value = Math.max(yFull, dragStart.value + e.translationY); })
    .onEnd((e) => {
      'worklet';
      const up = e.translationY < -DIST || e.velocityY < -VEL;
      const down = e.translationY > DIST || e.velocityY > VEL;
      if (snapSV.value === 'half') { if (up) snapTo('full'); else if (down) snapTo('close'); else snapTo('half'); }
      else { if (down) snapTo('half'); else snapTo('full'); }
    })
    .enabled(!config.preventClose);

  // Content pan: only take over when at top AND dragging down (decided in onUpdate, not onStart — M5).
  const active = useSharedValue(false);
  const contentGesture = Gesture.Pan()
    .onUpdate((e) => {
      'worklet';
      if (!active.value) { if (scrollAtTop.value && e.translationY > 0 && snapSV.value === 'full') { active.value = true; dragStart.value = translateY.value; } else return; }
      translateY.value = Math.max(yFull, dragStart.value + e.translationY);
    })
    .onEnd((e) => {
      'worklet';
      if (!active.value) return; active.value = false;
      if (e.translationY > DIST || e.velocityY > VEL) snapTo('half'); else snapTo('full');
    })
    .simultaneousWithExternalGesture(scrollRef);              // REAL ref — the handoff (C3)

  const sheetStyle    = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));

  // ... backdrop (Gesture.Tap), handle (handleGesture) as in SingleSnap ...
  return (
    // sheet height = SNAP_FULL, tokenized styling (see §10)
    <GestureDetector gesture={contentGesture}>
      <ScrollView
        ref={scrollRef}
        onScroll={(e) => { scrollAtTop.value = e.nativeEvent.contentOffset.y <= 0; }}
        scrollEventThrottle={16}
        bounces={false}
        keyboardShouldPersistTaps="handled"
        scrollEnabled={currentSnap === 'full'}               // the handoff key
      >
        <config.Component {...(config.props ?? {})} />
      </ScrollView>
    </GestureDetector>
  );
}
```

---

## 12. Android Back, Backdrop & Dismissal

- **Android hardware back** is handled in BOTH shells via `BackHandler`, respecting
  `preventClose`. Without it, back navigates the underlying screen and leaves the sheet mounted —
  a trapped state. (This is not optional and not "later.")
- **Backdrop** uses `Gesture.Tap()` through `GestureDetector` — one gesture system, no mixing with
  the legacy Responder API (which swallows taps during animations).
- **Close before navigation.** If content navigates, it must `sheet.close()` first (or use a
  router modal instead — §1). A future enhancement is binding the sheet's open-state to a route so
  the router closes it automatically; until then, closing first is the rule.
- **`dismissAll()`** exists on the stack/wizard variant (§16) mirroring the router.

---

## 13. Keyboard Strategy

- The shell wraps content in ONE `KeyboardAvoidingView` (`behavior: ios 'padding' / android
  'height'`). **Never nest a second** `KeyboardAvoidingView` in content (double-shift).
- `keyboardShouldPersistTaps="handled"` on every `ScrollView`/`FlatList` inside a sheet, or the
  first tap on a list item just dismisses the keyboard.
- **For sheets with text input, prefer `lg`/`full` single-snap over multi-snap.** The interaction
  between keyboard height and a live snap position is undefined and produces hidden-input bugs.
- Auto-focus search inputs (`autoFocus`) with `returnKeyType="search"`.
- For deterministic Android behavior, consider `react-native-keyboard-controller`; if a sheet
  offsets by keyboard height, drive it with a shared value rather than fighting
  `KeyboardAvoidingView`.

---

## 14. Theming — Tokens Only

This is a **lib component** and follows the design-system rules. No exceptions.

- Backdrop → `theme.overlay.scrim` (never `rgba(0,0,0,0.45)`).
- Radii → `theme.borderRadius.xLarge` / `.step` (never `20` / `2`).
- Spacing → `theme.sizing.*` (never `16` / `10`).
- Border widths → `theme.borderWidth.mild` (never `0.5`).
- Text → `Typography.*` with `color={theme.color…}` (never raw `<Text style={{fontSize:16}}>` or
  `color="white"`).
- `StyleSheet.create` is allowed for **layout only** (position/flex); all **values** resolve from
  the theme in the component body.

Dark mode is the reason: hardcoded `rgba`/hex/`"white"` don't adapt, and a POS used in varying
light needs dark mode to actually work.

---

## 15. RBAC & Subscription Gating at the Shell

Write-sheets are writes — they respect the same gates as the rest of the app, at the shell so
every caller doesn't re-implement it.

```typescript
// In open(), before showing:
if (config.requirePermission) {
  const { entity, action } = config.requirePermission;
  if (!snapshot.can(entity, action)) { toast('You don't have permission'); return; }
}
if (config.requiresWrite && !canWrite()) {          // canWrite = active/trialing/within grace
  router.push('/(app)/(modals)/subscription-wall'); return;
}
```

- **Action menus** must gate each item: a "Delete product" row is shown only if
  `can('Product','delete')`; a disabled row with a reason is better than a silent 403 later.
- **Write forms in sheets** (stock adjust, cash-in) pass `requiresWrite: true` → a lapsed account
  routes to the subscription wall instead of queuing a write that will be rejected
  `SUBSCRIPTION_LAPSED_AT_WRITE`.
- Reads (detail peeks, pickers over already-synced data) are never gated by subscription.

---

## 16. Stacked Sheets vs Wizards

**Default to a wizard (one sheet, internal steps), not a stack.** Most "stacked" flows (payment
method → amount → confirm) are one logical flow and should be a single sheet with `step` state
(the multi-step async pattern, §19). This avoids the remount/re-fetch that a stack causes when the
lower layer unmounts.

**Use a real stack only for genuinely independent sheets.** If you do, the stack variant must
render lower layers (scaled/dimmed, non-interactive) so their state survives and there's visual
depth — not just the top. `dismissAll()` closes the whole stack.

```typescript
// Wizard (preferred): one sheet, step ∈ 'method'|'amount'|'confirm'|'submitting'|'done'
// Stack (rare): only if the two sheets are truly independent contexts.
```

---

## 17. Snap Point Reference

| Snap | Height | Use |
|---|---|---|
| `sm` | 35% | confirmations, short menus (3–5), PIN, quick info |
| `md` | 55% | pickers (tax/category/unit), payment method list |
| `lg` | 80% | forms, long lists, detail, stock adjustment |
| `full` | 100% | camera, map, signature |
| `multiSnap half` | 50→92% | product/customer/order lists with preview |
| `multiSnap full` | starts 92% | long content that starts expanded, still dismissible |

---

## 18. Multi-Snap Behaviour Table

| Action | At HALF | At FULL |
|---|---|---|
| Drag handle up (fast/>60px) | → FULL | stays FULL |
| Drag handle down (fast/>60px) | → CLOSE | → HALF |
| Drag handle tiny | snap back HALF | snap back FULL |
| Scroll content up | → FULL | scrolls |
| Scroll content down at top | — | → HALF |
| Scroll content down mid-page | — | scrolls |
| Tap backdrop | CLOSE | CLOSE |
| `close()` from content | CLOSE | CLOSE |
| Android back | CLOSE | CLOSE |
| `preventClose` set | all blocked | all blocked |

---

## 19. Scenarios (config recipes)

Each uses `Component + props`. Content >10 lines of JSX must be its own component.

- **Confirmation** (delete/discard/void): `snapPoint:'sm', closeOnBackdrop:true, requirePermission`.
- **Picker** (tax/category/unit): `snapPoint:'md'`, `FlatList` inside, `keyboardShouldPersistTaps`.
- **Search picker** (customer/product): `snapPoint:'lg'`, content owns query state, `autoFocus`.
- **Multi-step async form** (quick-add customer, stock adjust, cash-in/out):
  `snapPoint:'lg', closeOnBackdrop:false, showHandle:false, requiresWrite:true`; submit via
  `sheet.runLocked(async () => …)`; steps `form|submitting|done`; auto-close on done.
- **Action menu** (long-press): `snapPoint:'sm'`, gate each item by RBAC, disabled rows show reason.
- **Async loading peek** (customer detail): `snapPoint:'lg'`, content renders
  `SheetSkeleton`/`SheetError`/data.
- **Full-screen** (scanner/signature): use a **router modal**, not a sheet (it's a destination).
- **Multi-snap list** (POS product add): `multiSnap:true, initialSnap:'half'`, `FlatList` content.

---

## 20. Reusable Content Components

`SheetSkeleton` (loading), `SheetError` (message + retry), `SheetListItem` (label/subtitle/
selected/icon/badge/destructive), `SheetSearchBar` (auto-focus), `SheetConfirmActions`
(confirm/cancel pair with `loading`). All tokenized, all in `components/BottomSheet/`. Use these
instead of re-inlining picker rows and states.

---

## 21. Accessibility

- `accessibilityViewIsModal` on the sheet container (screen readers ignore content behind).
- Drag handle: `accessibilityRole="adjustable"` + label + hint (announces expand/collapse).
- Backdrop: `accessibilityRole="button"` + label "Close".
- Picker rows: `accessibilityRole="menuitem"` + `accessibilityState={{ selected }}`.
- Action items: label + `accessibilityState={{ disabled }}`.
- **Focus management:** on open, move screen-reader focus to the sheet title; on close, restore to
  the triggering element (store the trigger ref in `open`).
- **Reduce motion:** respect `AccessibilityInfo.isReduceMotionEnabled` → 0-duration animations.

---

## 22. Performance

- **No heavy compute on content mount** — content mounts on every `open()`; defer filtering to
  `useEffect`/`useMemo`, don't block the open animation.
- **`FlatList`, not `ScrollView + map`** for lists in sheets (a `lg` sheet with 200 mapped rows
  renders all 200). Provide `getItemLayout` where row height is fixed.
- **`scrollEventThrottle={16}`** on multi-snap ScrollViews — the handoff needs frequent scroll
  position updates or the collapse feels laggy.
- **Content is a component ref (§9)** so `updateConfig` (e.g. `runLocked` toggling `preventClose`)
  never remounts it.
- **Snap animations on the UI thread** — never `runOnJS` a `withSpring`; JS-thread jank during
  list render would stutter the snap.

---

## 23. Dos & Don'ts

**Do:** extract content >10 lines into its own component · lock async with `runLocked` (never
manual `preventClose`) · `sheet.close()` before navigation (or use a router modal) · provide an
explicit close button whenever `closeOnBackdrop:false` · `bounces={false}` on multi-snap
ScrollViews · use `sm` for confirmations · close before the success callback · use `onClose` for
cleanup · gate write-sheets with `requiresWrite`/`requirePermission`.

**Don't:** store a rendered element as content (use `Component+props`) · nest a second
`KeyboardAvoidingView` · use `position:absolute` inside content · forget
`keyboardShouldPersistTaps` · open a sheet in a `useEffect` without a guard · rely on content-owned
form state after close (lift it) · set `preventClose` without `runLocked` · use `full` for
non-full-screen content · model a wizard as a stack · bounce snap animations through `runOnJS`.

---

## 24. Common Mistakes & Fixes

- **Flicker on open** → init `translateY` at `snapHeight` (offscreen), not 0.
- **Drag fights scroll in full sheet** → wrap only the handle in the drag gesture; the scroll area
  gets its own `contentGesture` with `simultaneousWithExternalGesture(scrollRef)` (a **real ref** —
  no-arg is a no-op).
- **Snap jank under load** → keep `withSpring` on the UI thread; only `runOnJS` the React state
  setter.
- **`scrollEnabled` desyncs from snap** → single shared value `snapSV` + `useAnimatedReaction` →
  `setCurrentSnap`; don't keep a parallel ref.
- **Keyboard hides input on Android** → `behavior='height'` on Android; prefer single-snap for
  input sheets; test explicitly.
- **`preventClose` doesn't block swipe** → gestures read `configRef.current`, not a captured
  closure.
- **Sheet content won't scroll at full** → `scrollEnabled={currentSnap==='full'}`, not hardcoded.
- **Android back doesn't close** → `BackHandler` in the shell (respect `preventClose`).
- **User permanently trapped** → only set `preventClose` via `runLocked` (finally-unlock).
- **Sheet behind the nav header** → `BottomSheetProvider` must wrap the navigation stack, not sit
  inside it.
- **Content remounts on `updateConfig`** → store `Component+props`, not a rendered element.
- **Wrong height after rotation** → `useWindowDimensions()`, not a module-level `Dimensions.get`.

---

## 25. Decision Guide

```
What am I building?                              System / config
─────────────────────────────────────────────────────────────────────────────
Deep-linkable / survives nav / a destination     ROUTER MODAL ((modals) group)
  step-up MFA, store-switcher, location-picker,   presentation:'modal'
  subscription-wall, full-screen scanner
─────────────────────────────────────────────────────────────────────────────
Delete/discard/void confirmation                 sheet sm, closeOnBackdrop:true, requirePermission
GST/category/unit picker                         sheet md, closeOnBackdrop:true
Payment method selector                          sheet md, closeOnBackdrop:false
Customer/product search picker                   sheet lg, closeOnBackdrop:true, autoFocus
Quick-add / stock-adjust / cash form             sheet lg, closeOnBackdrop:false, requiresWrite, runLocked
Order note input                                 sheet sm, closeOnBackdrop:true
Manager PIN entry                                sheet sm, closeOnBackdrop:false, showHandle:false
Shift-close summary                              sheet md, closeOnBackdrop:false
Cash tender numpad                               sheet md, closeOnBackdrop:false
Customer detail w/ history                        sheet multiSnap half
Product/customer/order list (POS)                 sheet multiSnap half
Product long-press menu                          sheet sm, closeOnBackdrop:true, per-item RBAC
Payment method → amount → confirm                 WIZARD (one sheet, step state) — not a stack
```

---

## 26. Migration from the Old Sheet

The prior implementation had: `content` as a rendered element, `runOnJS(snapTo)` (JS-thread
snapping), a `currentSnapRef` + state dual source, `simultaneousWithExternalGesture()` with no
ref (dead handoff), `rgba()`/hardcoded styling, no `BackHandler`, and manual `preventClose`. Migrate
per file:

1. **Config:** replace `content: <X/>` with `Component: X, props: {...}` (§9).
2. **Locking:** replace manual `updateConfig({preventClose})` pairs with `sheet.runLocked(fn)` (§8).
3. **Multi-snap:** replace `currentSnapRef`+state with `snapSV` + `useAnimatedReaction` (§11); make
   `snapTo` a worklet; pass a real `scrollRef` to `simultaneousWithExternalGesture`.
4. **Styling:** swap every `rgba`/hex/px for `theme.overlay.*`/`theme.color*`/`theme.sizing.*`/
   `theme.borderRadius.*`/`theme.borderWidth.*`; raw `<Text>` → `Typography` (§14).
5. **Back:** add `BackHandler` to both shells (§12).
6. **Dimensions:** `Dimensions.get` module constant → `useWindowDimensions()` (§24/M1).
7. **Boundary:** move full-screen scanner/signature and any deep-linkable modal to the router
   `(modals)` group (§1–§2).
8. **Gating:** add `requirePermission`/`requiresWrite` to write and privileged sheets (§15).

Average migration: ~30–45 min per sheet call site; the shell rewrite is once.

---

*End — Modal & Bottom Sheet Architecture. Router modals follow the Expo Router doc; this governs
the imperative bottom-sheet system. When it changes, review sheet call sites for compliance within
one sprint.*
