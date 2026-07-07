# CLAUDE.md — React Native · Expo Router Mobile Engineering Standard

> An enterprise-grade standard for building and reviewing the mobile app (React Native · Expo
> Router · offline-first). It defines the architecture, system design, code standards, UI
> standards, and best practices the app must follow — and encodes the mistakes most React Native
> apps make so they're caught and prevented. Use it both ways: as **rules when writing** mobile
> code, and as a **review checklist when auditing** it.
>
> **Grounds itself in the app's own systems:** the NKS design system (tokens, `styled-components`,
> `Typography`, shared components), Expo Router navigation, the offline-first sync engine, forms,
> and loading patterns. When those exist, follow them; this standard is the umbrella over them.
>
> These are rules, not suggestions. When a rule conflicts with a request, surface it and follow the
> rule unless explicitly overridden.

---

## 0. The ten commandments (the highest-order rules)

1. **The UI is driven by local state, never the network.** Reads render from local DB/cache
   instantly; the network updates state in the background. Never block a screen on a request.
2. **Never a white/blank screen.** Every load resolves to content, skeleton, empty, or error — and
   cache renders before any loader.
3. **Navigation state is declarative and guarded.** Auth/permission/subscription gates are
   `<Redirect>` in layouts, not `useEffect` redirects (no flicker). Groups swap via `replace`.
4. **Tokens only, no hardcoded values.** Every color/spacing/radius/font comes from the design
   system; no `#hex`, no magic `px`, no inline style for themed values.
5. **State lives at the right level.** Server state in the query/sync layer, global app state in the
   store, local UI state in the component — never mixed, never duplicated.
6. **Every list is virtualized and paginated.** `FlatList`/`FlashList`, stable keys, `getItemLayout`
   where possible — never `ScrollView + map` over unbounded data.
7. **Writes are optimistic and offline-safe.** Update the UI immediately, queue the mutation, roll
   back on failure — never make the user wait on a write.
8. **No secrets, no trust in the client.** No keys in the bundle; the server re-validates
   everything; the client is never the security boundary.
9. **Accessibility and performance are requirements, not polish.** Labels on interactive elements;
   no needless re-renders on the hot path.
10. **Consistency over cleverness.** Shared components and patterns over per-screen reinvention; the
    app reads like one author.

---

## 1. Architecture & system design

### Layered structure
```
app/                  ← routes ONLY (Expo Router); screens are thin
  (groups)/           ← auth-state route groups; _layout owns navigators + guards
features/<domain>/    ← the real code, by domain (products, orders, customers…)
  screens/            ← screen components (composition, not logic)
  components/         ← feature-specific components
  state/              ← slices/stores/hooks for this domain
  api/                ← this domain's server calls
  db/                 ← local SQLite queries for this domain
  schema.ts, transform.ts, types.ts
libs-mobile/          ← @nks/mobile-theme + @nks/mobile-ui-components (design system)
lib/ or core/         ← cross-cutting: query client, sync engine, storage, auth, config
```

- **Routes are thin.** A file in `app/` composes a screen and wires params/navigation — it holds
  no business logic. Logic lives in `features/`.
- **Feature-first, not layer-first at the top level.** Group by domain so a feature is
  self-contained and deletable; avoid a giant global `components/` and `redux/` grab-bag.
- **The design system is a dependency, not part of the app.** App code imports from
  `@nks/*`; styling never lives in screens.
- **One boundary per concern:** navigation (Expo Router), server state (query/sync), global state
  (store), local persistence (SQLite/MMKV), theming (design system). Don't blur them.

### State architecture (get this right — most apps don't)
Four distinct kinds of state, each with ONE home:
- **Server/cache state** → the query layer or sync-store (products, orders from the backend).
  Never copy it into Redux by hand; never treat it as local UI state.
- **Global app state** → the store (active store/location, auth/session, cart) — things many
  screens share.
- **Local UI state** → `useState` in the component (a toggle, a form field, a modal-open flag).
- **Navigation state** → Expo Router / route params — the source of truth for "where am I."

The #1 RN state mistake is smearing these together: server data manually duplicated into Redux,
UI state lifted to global for no reason, navigation state mirrored in a store. Keep them separate.

### Offline-first system design
This app is offline-first — the architecture reflects it:
- **Local DB is the read source of truth**; the UI reads from it, always available.
- **Writes go to a durable mutation queue** (optimistic apply → queue → background sync).
- **Sync is background and non-blocking**; cursors/watermarks drive deltas; conflicts resolve per
  the sync engine's rules (additive for transactional, optimistic-lock for master data).
- **Point-in-time authority** is honored for offline mutations; the client never assumes "now."
- **The network is an enhancement, not a dependency** — the app is fully usable offline.

---

## 2. The common RN/Expo mistakes this standard prevents

These are the mistakes most React Native apps ship. Catch every one:

**Navigation**
- Redirecting in `useEffect` (flicker) instead of `<Redirect>`.
- `push` where `replace` was needed → back button returns to login/checkout.
- Not resetting/killing stacks → stale screens under new ones; memory growth.
- Business logic in route files; screens that aren't thin.
- Modals as ad-hoc state instead of router modals or a proper sheet system → back/deep-link break.

**State & data**
- Server data hand-copied into Redux → drift, stale UI, double source of truth.
- `useState` for server data → refetch storms, no cache.
- Over-globalizing local UI state → needless re-renders, coupling.
- Fetching in `useEffect` without cleanup/cancellation → race conditions, set-state-after-unmount.
- No cache → every screen visit refetches → slow, data-hungry, blank flashes.

**Performance**
- `ScrollView + map` over long lists → renders everything, jank, memory.
- Inline functions/objects in render passed to memoized children → memoization defeated.
- Missing `useCallback`/`useMemo` on the hot path; or over-using them everywhere (noise).
- Anonymous components / unstable keys in lists → remounts, lost state.
- Heavy work on the JS thread (large maps, JSON parse) blocking the UI → dropped frames.
- Not using `InteractionManager`/deferring work after animations/navigation.
- Re-rendering the whole screen on one field change (top-level `watch`, unscoped context).

**Rendering & UI**
- White/blank screens before data; skeleton over cached data; layout jump on load.
- Loaders where cache exists (unwanted); no loader where needed (blank).
- Hardcoded colors/spacing → breaks dark mode and theming.
- Not handling safe areas / notches / keyboard → content under the notch or keyboard.
- Fixed pixel layouts that break on tablets/small phones → no responsive/scaled sizing.
- Images unoptimized/uncached → memory spikes, slow scroll.

**Lifecycle & memory**
- Listeners/subscriptions/timers not cleaned up → leaks, ghost callbacks.
- State updates after unmount; effects that re-run on every render.
- Not handling app background/foreground (re-auth, refetch, pause timers).
- Deep-link/cold-start not handled → crash or wrong screen on launch.

**Native & platform**
- iOS/Android differences ignored (keyboard behavior, back button, safe area, permissions).
- Permissions not requested/handled gracefully (camera, notifications).
- Not testing on a real low-end device → "works on my flagship" perf.

**Security**
- Secrets/keys in the JS bundle (it's not secret).
- Sensitive data in `AsyncStorage` (unencrypted) instead of secure storage.
- Trusting client-side checks; no server re-validation.

---

## 3. Code standards

- **TypeScript strict.** No `any` on domain logic; precise types; domain types over primitives
  where it clarifies (`StoreId`, `Paise`). Correct nullability, no `!` littering.
- **Components: composition over size.** A screen composes small components; a component that's
  200+ lines or does data + logic + layout should be split. Presentational vs container separation
  where it clarifies.
- **Hooks for logic.** Reusable/complex logic lives in custom hooks (`useX`), not copy-pasted in
  screens. Rules-of-hooks respected; dependency arrays correct and honest.
- **No inline styles for themed values; `styled-components` template-literal + tokens** (per the
  design system). Layout-only `StyleSheet` is fine; values come from the theme.
- **Naming:** components PascalCase, hooks `useX`, files consistent with the design-system
  convention (kebab for lib components). Names reveal intent and type.
- **Effects:** every subscription/listener/timer returns a cleanup; fetches cancel on unmount;
  effect deps are complete. Prefer derived state over effects that sync state to state.
- **Error boundaries** around screens/features so one crash doesn't white-screen the app.
- **No dead code, no commented-out blocks, no console.logs in committed code.**
- **Imports** from package roots (design system), not deep paths; no circular deps between features.

---

## 4. UI standards

- **Design tokens only** — color/spacing/radius/typography/shadow from `@nks/mobile-theme`. Dark
  mode works because nothing is hardcoded.
- **`Typography` for all text**, never raw `<Text>` with inline font styles.
- **Shared components** (`Button`, `Input`, `Card`, `Row/Column/Flex`, list scaffolds, modals) —
  don't reinvent primitives per screen.
- **Safe areas & keyboard:** every screen respects `SafeAreaView`/insets; inputs use keyboard
  avoidance and `keyboardShouldPersistTaps`; last field clears the keyboard.
- **Responsive & scaled:** use breakpoint/scaling hooks; no fixed pixel layouts that break on
  tablet or small phones; touch targets ≥ 44pt.
- **Loading UX:** skeletons match layout, cache renders first, no white screens, splash held until
  ready (follow the loading standard).
- **Feedback:** every action has visible feedback (button loading, optimistic update, toast);
  destructive actions confirm; errors show with retry.
- **Consistency:** spacing rhythm, typography scale, and interaction patterns uniform across
  screens — the app feels like one product.
- **Accessibility:** `accessibilityLabel` on every interactive element; required/disabled/busy
  states announced; sufficient contrast (tokens handle it); dynamic type respected.
- **Motion:** purposeful, interruptible, respects reduce-motion; animations on the UI thread
  (Reanimated), never janky JS-thread loops.

---

## 5. Performance standard

- **Lists:** `FlatList`/`FlashList`, stable `keyExtractor`, `getItemLayout` for fixed rows,
  `windowSize`/`initialNumToRender` tuned, no inline renderItem closures that break memo.
- **Memoization with intent:** `React.memo` on list rows and expensive children; `useCallback`/
  `useMemo` where identity matters (passed to memoized children, dep arrays) — not sprinkled
  everywhere.
- **Scoped re-renders:** subscribe to the smallest state slice (selector/`useWatch`/scoped
  context); never re-render a screen for one unrelated field.
- **Off the JS thread:** heavy compute deferred (`InteractionManager`, after animations),
  animations on Reanimated UI thread, large parse/transform batched or backgrounded.
- **Images:** cached, sized, lazy where long lists; avoid full-res in thumbnails.
- **Startup:** minimal work before first paint; splash held; defer non-critical init.
- **Measure on a real low-end device**, not just a flagship or simulator.

---

## 6. Reliability & lifecycle

- **App state:** handle background/foreground — pause timers, refetch/revalidate on resume,
  re-check auth/session, flush the sync queue.
- **Cold start & deep links:** the app launches to the correct screen from a link or notification;
  guards still run; resume-after-login stashes the intended route.
- **Crash containment:** error boundaries per feature; a failed screen shows an error state, not a
  white app.
- **Memory:** clean up every listener/timer/subscription; no leaks across navigation; no growing
  stacks.
- **Network transitions:** online↔offline handled gracefully; a dropped request degrades, doesn't
  crash; reconnection resumes sync.

---

## 7. Security standard

- **No secrets in the bundle** — API keys/signing secrets live server-side; the client gets scoped,
  short-lived tokens.
- **Secure storage** for tokens/sensitive data (Keychain/Keystore via secure-store), never plain
  `AsyncStorage`.
- **The client is not the security boundary** — every permission/limit/ownership check is
  re-validated server-side; client checks are UX only.
- **Tenant/permission from the authenticated context**, never trusted from client input.
- **Certificate/deep-link hygiene** — validate deep-link params; don't act on untrusted link
  content without confirmation.
- **PII discipline** — minimize what's stored/logged on device; respect data-erasure requirements.

---

## 8. Testing standard

- **Risky logic is tested:** offline queue + rollback, sync/conflict handling, money/tax
  calculations, auth/permission gating, form validation.
- **Component tests** for critical screens (loading/empty/error/data states; the four form
  scenarios; navigation guards).
- **Tests assert behavior, not implementation trivia**; readable; the risky paths have coverage
  before the easy ones.
- **Test on real devices** (iOS + Android, low-end included) for perf and platform behavior.

---

## 9. Definition of done (self-check for any mobile work)

- [ ] UI renders from local state; no screen blocks on the network; no white screen.
- [ ] Loading resolves to content/skeleton/empty/error; cache renders before any loader.
- [ ] Guards are `<Redirect>` in layouts; auth/store transitions use `replace`.
- [ ] All styling from tokens; `Typography` for text; shared components reused; dark mode works.
- [ ] State at the right level (server/global/local/nav), no duplication of server data.
- [ ] Lists virtualized, keyed, paginated; no `ScrollView + map` over unbounded data.
- [ ] Writes optimistic + queued + rollback; offline-safe; point-in-time respected.
- [ ] Effects clean up; no set-state-after-unmount; deps correct.
- [ ] Safe areas + keyboard handled; responsive/scaled; touch targets ≥ 44pt.
- [ ] a11y labels/states present; reduce-motion respected; animations on UI thread.
- [ ] No secrets in bundle; secure storage for tokens; server re-validates everything.
- [ ] Risky logic tested; error boundaries around features.
- [ ] TypeScript strict; no `any` on domain logic; no dead code/console.logs.

If any item fails, the work isn't done.

---

## 10. Rules of engagement (when reviewing existing code)

- Enumerate what you're reviewing (screens/features), then check against §0–§8.
- Lead findings with **what the user experiences** (mobile defects are UX defects).
- Rank by user-visible impact and crash/perf risk: white screens, crashes, jank, leaks first;
  then architecture/state; then standards nits.
- Cite `file:line`; distinguish "definitely wrong" from "smell" from "judgment call."
- Flag both under-engineering (missing guards/cleanup/virtualization) and over-engineering
  (needless global state, premature abstraction, memo-everything noise).
- Recognize what's genuinely well-built so it's preserved.
- Don't refactor unless asked — deliver the review and prioritized fixes.

---

*Attach this agent to build or review the React Native · Expo Router mobile app to an
enterprise-grade standard: layered feature-first architecture, correct state and offline-first
system design, the common RN mistakes caught and prevented, strict code standards, token-based UI
standards, performance, reliability/lifecycle, security, testing, and a definition-of-done — all
grounded in the app's design system, navigation, sync, forms, and loading patterns. Thinking as a
principal mobile engineer who has shipped and operated apps at scale.*
