# CLAUDE.md — Ayphen Retail Mobile (Expo Router)

> Instructions for AI coding agents (Claude Code / Cursor / Copilot) working on the
> **React Native · Expo Router** navigation layer of Ayphen Retail, an offline-first POS.
> These are **rules, not suggestions.** When a rule conflicts with a request, surface the
> conflict and follow the rule unless the human explicitly overrides it.

---

## 0. Context you must hold

Ayphen Retail is an **offline-first POS**. The app reads/writes local SQLite and never blocks
on the network; the server reconciles in the background. Navigation is driven **entirely by
local state** — auth, the RBAC snapshot, the store-open state machine, and the active store —
all of which work offline. The network only *updates* that state in the background; it must
**never gate a navigation transition**.

Three hard dependencies you must respect in every navigation decision:
- **RBAC snapshot** — a signed, per-store `{ crud, special, locations }` document already on
  device from bootstrap. Permission checks are zero-network reads against it.
- **Store-open state machine** — a store must reach `READY` before its POS renders
  (NONE→RESOLVE→CLAIM_SLOT→OPEN_CONTEXT→MIGRATE→COLD_START?→DELTA→READY).
- **Subscription write-gate** — reads are NEVER blocked; only writes are gated.

---

## 1. Golden rules (violating these is a bug, not a style choice)

1. **Guards are declarative `<Redirect>`, never imperative `useEffect` + `router.replace`.**
   Redirects must run during render (before paint). An effect-based redirect flashes forbidden
   content for one frame.
2. **Switching auth/store state uses `replace`, never `push`.** Login success, store creation,
   store switch, and logout must collapse history so the OS Back button can't return to the
   prior shell.
3. **Pass IDs through params, never objects.** Params serialize to the URL. Read the full row
   from SQLite in the child. Passing objects bloats the URL and goes stale.
4. **Never hold cart/draft/in-progress state in a screen component.** A `back()` unmounts it.
   Lift durable state to a provider or a SQLite draft row.
5. **Never gate a read behind subscription.** Gate only write *actions*. A lapsed merchant must
   still see their data.
6. **Hiding a control is UX; guarding the route is security.** Every RBAC-sensitive route needs
   a layout-level `<Redirect>` guard, not just a hidden button — a role revoked mid-session must
   kick the user off a screen they're already standing on.
7. **Navigation follows the local optimistic commit, never the server mutation result.** Move
   the user on local write; reconcile the server result separately (toast + rollback on reject).
8. **`MIGRATE` runs before any screen queries SQLite.** The store-open state machine gates this;
   never mount a data screen ahead of migrations (INV-5 — corrupts local data otherwise).

---

## 2. Folder & route conventions

- The `app/` directory **is** the route table. Do not register screens in code; create files.
- `_layout.tsx` declares a navigator (Stack/Tabs/Drawer) and adds **no** path segment.
- `(group)` folders organize without adding a URL segment. Use them for auth shells and modals.
- `[param]` = dynamic segment; `[...rest]` = catch-all; `index.tsx` = the group default.
- **Auth shells are groups:** `(auth)` unauthenticated · `(onboarding)` authed-no-store ·
  `(app)` authed-with-store · `(admin)` super-admin. A user is in exactly ONE at a time.
- **Modals live in `(app)/(modals)/`** with `presentation:'modal'` in the group layout.
- **Do not nest beyond `feature/[id]/action`** (≈3 meaningful segments). Deeper nests are brittle.
- Feature stacks (`products/`, `orders/`) sit as siblings of `(tabs)` inside `(app)` and are
  **pushed over** the tab bar.

When asked to add a screen, create the file in the correct group, wire it into the nearest
`_layout.tsx` `<Stack.Screen>`/`<Tabs.Screen>` list, and add its guard if RBAC-sensitive.

---

## 3. The auth gate (how to place redirects)

- `app/index.tsx` is the entry decider: unauthenticated → `(auth)`; super-admin → `(admin)`;
  no store → `(onboarding)`; else → `(app)/(tabs)`. All via `<Redirect>`.
- **Each group layout re-asserts its own precondition** with `<Redirect>` — a deep link lands
  inside a group, so the group itself must guard (defense in depth).
- `(auth)/_layout` bounces authenticated users OUT (`<Redirect href="/" />`).
- On login/signup success: `router.replace('/')` and let index re-decide. Never `push`.
- Session death anywhere: `AuthProvider` clears session → `(app)/_layout` re-renders its
  `<Redirect>` → the entire `(app)` subtree unmounts in one frame. Do not manually navigate on
  session loss; let the guard do it.

---

## 4. The store-open state machine (do not render the POS early)

- `(app)/_layout` must render a `StoreOpenGate` that switches on the machine state:
  RESOLVE/CLAIM_SLOT/OPEN_CONTEXT/MIGRATE → a lightweight "opening" screen; COLD_START → a
  progress screen; ERROR → the correct wall; READY/DELTA → the real `<Stack>`/`<Tabs>`.
- **The navigator only mounts at READY/DELTA.** Never render tabs during MIGRATE or COLD_START.
- COLD_START unlocks the POS at dependency groups G1–G3 (config + catalog) and finishes G4–G5
  in the background — do not block to 100%.
- `410 UPGRADE_REQUIRED` → ERROR state, upgrade wall. `410 SYNC_HORIZON_EXCEEDED` → drop the
  store partition, re-enter COLD_START. Handle these in the machine, not per-screen.

---

## 5. Navigation verbs (pick correctly)

| Use | When |
|---|---|
| `router.push` | drilling into detail; Back should return here |
| `router.replace` | auth/store state changes; Back must NOT return here |
| `router.back` | explicit single pop |
| `router.dismiss(n)` / `dismissAll` | closing modal / multi-step modal flows |
| `router.setParams` | in-place filter/search state, no new screen |
| `<Link href>` | declarative navigation in lists (prefetch, a11y) |

Decision rule: **if returning here via Back would be wrong, use `replace`.** Checkout success,
post-login, post-store-creation, store switch → `replace`.

---

## 6. Stack lifecycle (maintain vs kill)

- Pushed screens stay **mounted but inactive** (state + scroll preserved). A pop **unmounts**
  (kills) the popped screen.
- To kill a whole flow: `replace` (collapse history), `dismissAll()` (modal wizard), or
  `popToTopOnBlur:true` on a nested tab stack (reset to root when the user leaves it).
- State that must survive a pop lives in a provider or SQLite, never in the screen.
- Intercept hardware Back for unsaved work with `navigation.addListener('beforeRemove', …)` +
  `e.preventDefault()`; only dispatch the action after the user confirms discard.

---

## 7. Params (parent → child)

- Navigate with `{ pathname: '/orders/[id]', params: { id } }`. Read with
  `useLocalSearchParams<{ id: string }>()`. Prefer `useLocalSearchParams` over
  `useGlobalSearchParams` (scoped, fewer re-renders).
- Child re-reads the row from SQLite by id (`useOrder(id)`), reactively — so a child mutation
  reflects in the parent when popped, with no callback passed through params.
- Never pass callbacks or large objects through params.

---

## 8. RBAC gating (implement all three levels)

Use the `useSnapshot()` helper: `can(entity, action)`, `canSpecial(entity, code)`,
`isAssignedToLocation(locId)`, `isOwner`, resolved against the **active store's** snapshot entry.

1. **Hide entry points** — `{can('Report','view') && <ReportsTab/>}`; tabs use
   `href: can(...) ? undefined : null` to hide the button without unmounting the route.
2. **Guard routes** — the RBAC-sensitive layout returns `<Redirect>` if the check fails. This is
   the security boundary; it must survive a live permission change (snapshot swap re-evaluates
   the guard and evicts a just-demoted user).
3. **`RequirePermission` component** for one-off screens.

Store-scoped truth: permissions resolve against `activeStoreId`. `USER` system role grants NO
store permissions — only roles with the store's `store_fk` count. `SUPER_ADMIN` routes live under
`(admin)` guarded separately.

---

## 9. Subscription & step-up gates

- **Subscription:** gate write *actions* with `useCanWrite()` (active/trialing/within
  access_valid_until). Render the screen (reads allowed); route the write button to
  `(app)/(modals)/subscription-wall` when blocked.
- **Step-up (MFA):** sensitive actions (refund/void/ownership transfer) call `ensureStepUp('5m')`
  which resolves instantly if recent, else pushes `(modals)/step-up` and awaits the result.
  These routes ALSO carry the RBAC-special guard — both gates stack, both must pass.
- Step-up modal: `gestureEnabled:false` (no swipe-dismiss on an MFA gate).

---

## 10. Multi-store switching

- Switch via `switchStore(storeId)` (rebinds the sync engine to the new `store_fk` partition),
  then `dismissAll()` + `router.replace('/(app)/(tabs)')` to kill the previous store's open
  stacks. Never leave Store A's order detail mounted after switching to Store B.
- The snapshot covers all stores in one document → permission switch is zero-network.

---

## 11. Offline & real-time

- Ambient offline chip in `(app)/_layout`, above the navigator; navigation never blocks on it.
- Optimistic write updates UI instantly + enqueues; on later `rejected` (e.g.
  `SUBSCRIPTION_LAPSED_AT_WRITE`), toast + rollback — navigation already moved on.
- Live permission/subscription changes arrive piggybacked on sync responses; guarded layouts
  re-evaluate and redirect automatically. Never manually navigate on a permission change.

---

## 12. Provider order (fixed)

Root layout mounts: **Network → Auth → Snapshot → (per-store) Store.** Splash stays up until
bootstrap resolves (tokens read + snapshot loaded + initial route decided) to avoid a
login→POS flash. `SnapshotProvider` depends on Auth; `StoreProvider` lives inside `(app)`.

---

## 13. Definition of done (self-check before returning code)

Before you hand back navigation code, verify every item:

- [ ] Guards are `<Redirect>` in a layout, not `useEffect` redirects.
- [ ] Auth/store transitions use `replace`, not `push`.
- [ ] Params carry IDs only; child reads from SQLite.
- [ ] No durable state (cart/draft) lives in a screen component.
- [ ] No read is subscription-gated; only write actions are.
- [ ] Every RBAC-sensitive route has a layout `<Redirect>` guard, not just a hidden button.
- [ ] The POS navigator does not mount before store state is READY.
- [ ] MIGRATE precedes any SQLite query.
- [ ] Navigation fires on the local commit, not the server result.
- [ ] New screens are wired into the correct group's `_layout.tsx` screen list.
- [ ] Typed routes compile (no unknown-href errors).

---

## 14. Things to refuse or flag

- A request to **gate reads** behind subscription → flag; propose gating the write action instead.
- A request to **`push` into the auth stack after login** → flag; use `replace`.
- A request to **pass a full entity object through params** → flag; pass the id.
- A request to **render a POS screen before READY / before MIGRATE** → refuse; explain the
  corruption/UX risk.
- A request to **secure a route by only hiding its button** → flag; add the route guard too.

When flagging, state the rule, the concrete risk, and the correct alternative in one short note —
then implement the correct version unless the human overrides.

---

*This file governs the Expo Router layer only. Backend/sync/RBAC contracts live in their
respective PRDs; when navigation depends on them, follow the contract, don't reinvent it.*
