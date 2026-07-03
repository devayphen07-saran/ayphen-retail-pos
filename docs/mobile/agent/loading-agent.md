# CLAUDE.md — Mobile Loading Patterns (Ayphen Retail / NKS)

> Instructions for AI coding agents (Claude Code / Cursor / Copilot) implementing ANY loading,
> empty, error, or async state in the mobile app.
> **Stack (fixed):** React Native · Expo Router · Redux Toolkit · `styled-components/native` ·
> `@nks/mobile-theme` · `@nks/mobile-ui-components`.
> These are **rules, not suggestions.** The wrong loading type — or a loading state that never
> resolves, or a skeleton flashing over cached data — makes the app feel broken. When a rule
> conflicts with a request, surface the conflict and follow the rule unless the human explicitly
> overrides it.
> **This file inherits the NKS design-system rules** (template-literal styled-components,
> tokens-only, styles-below-component, `$`-prefixed props, barrel export). Loading components are
> lib components — build them to those rules.

---

## 0. The three laws of loading (never violate)

1. **Loading ALWAYS resolves** to success, error, or empty. A spinner that can spin forever is a
   bug. Every async path has a terminal state.
2. **Cache beats skeleton.** If cached/local data exists, show it immediately and refresh
   silently. NEVER flash a skeleton over data the user already had — that's a visible regression.
3. **Never destroy visible data to load.** Refresh, pagination, and re-fetch keep the existing
   list on screen; the indicator is additive (top spinner, footer spinner), never a wipe.

---

## 1. Pick the loading type from the decision tree

Run this before adding ANY indicator. The scenario dictates the type — do not default to a
full-screen spinner.

| Scenario | Loading type | Rule |
|---|---|---|
| First visit, **no cache**, known layout (list/detail/dashboard) | **Skeleton** matching the layout | zero layout shift on load |
| Return visit, **has cache** | **None** — show cache + silent background refresh | maybe a subtle refresh indicator |
| App boot (auth + hydration) | **Hold the splash screen**, then real content | no intermediate spinner |
| Navigate to screen with **unknown** layout | Full-screen spinner (last resort) | prefer skeleton whenever layout is known |
| **Write** — toggle/like/offline-first create/update | **Optimistic, no loading** | instant UI + background sync + rollback on fail |
| **Write** — standard save/submit | **Inline button spinner** (disable + spinner in button) | |
| **Write** — destructive (delete/cancel/refund) | Confirm dialog → **then** button spinner | |
| **Write** — critical/irreversible (payment/transfer) | **Full overlay blocker** ("Processing…") | must-not-interrupt |
| **Refresh** existing data | **Pull-to-refresh** (`RefreshControl`) | keep list visible |
| **Load more** (infinite scroll) | **Pagination footer** spinner | |
| **Search / filter** | Inline spinner near the search bar | keep existing results until new arrive |
| Multiple independent data sources | **Progressive** — each section loads independently | per-card skeletons |
| Background job the user doesn't watch (sync/export/bulk) | **Toast/snackbar progress** | |
| No data, not loading | **Empty state** — message + CTA | |
| Fetch failed, no cache | **Error state** — message + Retry | |

If the request asks for the wrong type for the scenario (e.g. a full-screen spinner on a known
list layout), flag it and use the correct type.

---

## 2. Skeleton rules

- Use **only** on first visit with no cache and a **known** layout.
- **The skeleton must match the real layout** (same card shape, same rows) so there is zero
  layout shift when data lands. A generic gray box that jumps to a different shape is wrong.
- Do NOT show a skeleton when the load is <100ms (feels like a flash) — but you generally can't
  know duration ahead of time, so the real guard is: skeleton only when `!hasData && isLoading`.
- **The four-way state rule (memorize):**
  - `data.length === 0 && isLoading` → **skeleton**
  - `data.length > 0 && isLoading` → **data + subtle refresh indicator** (NOT skeleton)
  - `data.length > 0 && !isLoading` → **data**
  - `data.length === 0 && !isLoading && isHydrated` → **empty state**
- Base primitive is `SkeletonBox`; each screen composes a screen-specific skeleton
  (`OrderListSkeleton`, etc.) matching its layout.

---

## 3. Full-screen spinner rules

- **Last resort**, only when the layout shape is genuinely unknown, or for auth
  (login/logout/refresh) with no layout to skeleton.
- **App boot uses the splash screen held**, not a spinner: `preventAutoHideAsync()` →
  do async boot (DB init, auth restore, hydrate) → `setReady(true)` → `hideAsync()`. User sees
  splash → real content, zero intermediate states.
- Never use a full-screen spinner for lists, details, or any known layout (use skeleton), or for
  writes (use button spinner / optimistic).

---

## 4. Inline button spinner rules

- Use for standard save/submit/confirm/status-change — any button that fires an API call.
- On tap: **disable the button AND replace its label with a spinner** in the same tick. Restore
  on success or failure. Double-tap must be impossible.
- Prefer the `AsyncButton` pattern: a `Promise`-returning `onPress` auto-tracks internal loading;
  an external Redux `loading` prop overrides it. `isDisabled = disabled || isLoading`.
- Spinner color: `theme.onColorPrimary` on filled variants, `theme.colorPrimary` on `default`.
- Never use for navigation buttons, optimistic actions, or reads.

---

## 5. Pull-to-refresh rules

- Use on every list screen, scrollable detail, and dashboard. NOT on forms or modal/bottom-sheet
  content (gesture conflicts).
- **Never clear the existing list while refreshing** — data stays visible, spinner appears on top.
- On refresh failure: toast the error but **keep the list** (do not empty `byId`).
- `RefreshControl` tint/colors from `theme.colorPrimary`.

---

## 6. Pagination footer rules

- Use for lists >~20 items / infinite scroll. Trigger via `onEndReached` +
  `onEndReachedThreshold ≈ 0.5`, guarded by `if (!isPaginating && hasMore)`.
- Footer shows "Loading more…" while paginating; "You've seen all N items" when `!hasMore &&
  itemCount>0`; nothing otherwise.
- Pagination loading is a **separate** flag (`paginationLoading`) from screen `loading` — never
  reuse the screen skeleton for load-more.

---

## 7. Overlay blocker rules

- Use ONLY for critical/irreversible operations (payment, transfer, file upload) that must not be
  interrupted. It's a `Modal` backdrop + card with spinner, optional progress bar, and a
  "Please don't close the app" note.
- Never use an overlay blocker for routine saves or reads — it's the heaviest, most intrusive
  state and should be rare.

---

## 8. Optimistic (no loading) rules

- Use for toggles, like/favorite/bookmark, and offline-first writes (create order, update
  product). This is the default for Ayphen's offline-first POS writes.
- Flow: **update Redux/UI instantly → fire API in background → on success do nothing → on failure
  ROLL BACK the optimistic change + toast.** The rollback is mandatory; an optimistic update
  without a rollback path is forbidden.
- Never show a spinner for an optimistic action — the whole point is instant feedback.

---

## 9. Progressive / toast rules

- **Progressive:** a screen with independent data sources renders each section with its own
  loading state (per-card skeletons). Don't block the whole screen on the slowest source.
- **Toast/snackbar progress:** for background jobs the user started but doesn't watch (sync,
  export, bulk). Show progress (`autoHide:false`) then a success toast (`autoHide:true`).

---

## 10. The screen state machine (every screen handles all of these)

Every data screen resolves to exactly one of: **LOADING (skeleton) · SUCCESS (data) · ERROR
(retry) · EMPTY (CTA) · OFFLINE (cache + banner)**. Use `ScreenStateRenderer` (or the
`useScreenState` hook) so the precedence is consistent:

1. `isLoading && !hasData` → skeleton
2. `isError && !hasData` → error state with Retry
3. `!hasData && !isLoading` → empty state with CTA
4. else → render data (children)

`hasData` = `Array.isArray(data) ? data.length>0 : data!=null`. The `!hasData` conditions are
what make cache win: with cached data present, you skip skeleton/error/empty and render data even
while a background refresh runs or an error occurs.

---

## 11. Redux integration rules

- **Separate loading flags per concern:** `loading` (screen), `paginationLoading` (load-more),
  `entityActionLoading: Record<id, string|null>` (per-row button spinners). Never overload one
  boolean for all three — a row action would spin the whole screen.
- `fetch.pending` → `loading=true, error=null`. `fetch.fulfilled` → `loading=false,
  hydrated=true, lastFetchedAt=now`, normalize. `fetch.rejected` → `loading=false, error=msg` and
  **DON'T clear `byId`** (keep cache visible).
- Per-entity action: `pending` sets `entityActionLoading[id]='confirming'`; `fulfilled`/`rejected`
  delete the key. The button reads `selectOrderActionLoading(id)`.
- Selectors expose `loading`, `error`(bool), `errorMessage`, `paginationLoading`, `hasMore`, and a
  memoized list selector (`createSelector` over `byId` + `allIds`).

---

## 12. `useScreenState` / `ScreenStateRenderer` — prefer them

- `useScreenState({ fetchAction, isLoading, isError, hasData })` returns `showSkeleton`,
  `showError`, `showEmpty`, `showData`, `showRefreshIndicator`, `isRefreshing`, `handleRefresh`,
  `handleRetry`, and fires the fetch on focus. Use it so every screen computes states identically.
- `showSkeleton = isLoading && !hasData`; `showRefreshIndicator = isRefreshing || (isLoading &&
  hasData)` — the latter is the "data + subtle refresh" case, NOT a skeleton.
- Fetch on `useFocusEffect`, not a bare `useEffect`, so returning to a screen refreshes it.

---

## 13. FORBIDDEN patterns (reject in review, refuse to write)

| Forbidden | Required replacement |
|---|---|
| skeleton shown while cached data exists | show data + background refresh |
| skeleton whose shape ≠ the real layout | screen-specific skeleton matching layout |
| clearing/emptying the list on refresh or on fetch error | keep `byId`; indicator is additive |
| a loading state with no terminal (can spin forever) | always resolve to success/error/empty |
| full-screen spinner on a known list/detail layout | skeleton |
| full-screen spinner for a write action | button spinner / optimistic |
| overlay blocker for a routine save/read | button spinner or optimistic |
| optimistic update with no rollback path | add Redux rollback + toast on failure |
| one boolean for screen + pagination + row actions | separate `loading`/`paginationLoading`/`entityActionLoading` |
| reusing screen skeleton for load-more | `PaginationFooter` with `paginationLoading` |
| button that can be double-tapped mid-submit | disable + spinner synchronously on tap |
| error state with no Retry | include `onRetry` |
| empty state with no message/CTA | `NoDataContainer` with title + action |
| bare `useEffect` to fetch on mount | `useFocusEffect` |
| hardcoded color/spacing/`rgba`/`px` in a loading component | `theme.*` tokens (NKS rules) |
| object-syntax styled / inline style / styles above component | template-literal, tokens, styles below |

> Note: the existing `OverlayLoader` in the doc uses a raw `rgba(0,0,0,0.5)` backdrop — when you
> touch or create overlay components, use `theme.overlay.scrimSoft` instead, per NKS rules.

---

## 14. Definition of done (self-check before returning any loading code)

- [ ] Correct loading TYPE chosen from the §1 decision tree for this exact scenario.
- [ ] Loading always resolves — no path can spin forever.
- [ ] Cache wins: no skeleton when `hasData`; skeleton only when `isLoading && !hasData`.
- [ ] Skeleton matches the real layout (zero layout shift).
- [ ] Refresh/pagination/error keep existing data visible (no wipe).
- [ ] Screen uses `ScreenStateRenderer`/`useScreenState` with correct precedence
      (loading→error→empty→data, all gated on `!hasData`).
- [ ] Buttons disable + spinner on tap; double-submit impossible.
- [ ] Optimistic writes have a rollback + toast on failure.
- [ ] Redux has separate `loading` / `paginationLoading` / `entityActionLoading`; `rejected`
      does not clear cache.
- [ ] Error state has Retry; empty state has message + CTA.
- [ ] Fetch runs on `useFocusEffect`.
- [ ] NKS rules hold: lib path, template-literal styled, styles below, tokens only, `$`-props,
      barrel export, `ColorType.xxx` for variants, overlays via `theme.overlay.*`.

If any item fails, the code is not done.

---

## 15. The four canonical timelines (implement so these hold)

- **First visit (no cache):** mount → `useSelector` empty → render skeleton → `dispatch(fetch)` →
  `loading=true` → API → `fulfilled` → `loading=false`, data normalized → re-render with data,
  skeleton replaced, **no layout shift**.
- **Return visit (cache):** mount → `useSelector` has data → render data immediately → background
  `dispatch(fetch)` → subtle refresh indicator → data updates in place. **No skeleton ever.**
- **Standard write:** tap → button disabled + spinner (same tick) → `dispatch` → success: restore
  button, update badge, toast / failure: restore + enable button, error toast, **Redux unchanged**.
- **Optimistic write:** tap → UI updates instantly (Redux optimistic) → API in background →
  success: nothing / failure: **rollback Redux + toast**.

---

## 16. Things to refuse or flag

- Request for a **full-screen spinner on a known layout** → flag; use a matching skeleton.
- Request to **show a skeleton on every load** (including cached) → flag; cache wins.
- Request to **clear the list while refreshing** → refuse; data stays visible.
- Request for an **optimistic toggle without rollback** → refuse; add the rollback path.
- Request for an **overlay blocker on a routine save** → flag; button spinner instead.
- Request to **fetch in `useEffect`** for a screen that should refresh on focus → flag;
  `useFocusEffect`.
- Any **loading state with no error/empty branch** → flag; every screen handles all five states.

When flagging: state the rule, the concrete "feels-broken" risk, and the correct type/pattern —
then implement the correct version unless explicitly overridden.

---

*This file governs async/loading state and its wiring. The visual building blocks are NKS
design-system components (follow the design-system agent for tokens/syntax); form submit timing
lives in the forms agent; navigation-level gating (store-open state machine, cold-start progress)
lives in the router agent. Keep this file authoritative for "which loading state, when."*
