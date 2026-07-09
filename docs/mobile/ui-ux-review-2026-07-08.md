# Mobile App — Page-by-Page UI/UX Review

**Date:** 2026-07-08
**Method:** Each page reviewed per `docs/mobile/agent/CLAUDE-page-uiux-review.md` (purpose → issues by severity → necessity → space/layout → redesign verdict → what's good), condensed to one section per page. Grounded against the design-system, forms, loading, and navigation standards in `docs/mobile/agent/`.
**Scope:** 26 of the app's 28 screens (Local Tables debug screens excluded as internal dev tools, not held to enterprise UX standards).

---

## Executive summary — P0s (page fails its job)

| # | Page | Problem |
|---|------|---------|
| 1 | **PosScreen** | No cart, line items, running total, or checkout action anywhere — cashiers cannot ring up a sale. Product grid is hardcoded to `[]`. This is a placeholder shell, not a working POS screen. |
| 2 | **ProductsScreen** | `ProductCard` has no `onPress` — tapping a product does nothing, so existing products can never be viewed or edited, only created. |
| 3 | **CustomersScreen** | The screen's one primary action, "+ Add customer," has no `onPress` at all — dead button, zero feedback. |
| 4 | **PersonalWorkspaceScreen** | Only control on the page is "Log out." A user who picked "Personal" mode (told one screen earlier "you can switch anytime") has no way to switch to Business or reach Settings — logging out is the sole exit. |
| 5 | **ConflictsScreen** | "Keep mine" / "Use server" fire immediately with no confirmation, permanently discarding one side of the data with no undo. Additionally, conflict cards often show no real per-field diff (falls back to a raw GUID), so users choose blind. |

These five block or actively mislead users on their primary task and should be prioritized over everything else in this report.

## Cross-cutting themes (recurring across many pages)

- **Hardcoded style values instead of design-system tokens** — raw px/rgba/shadow literals appear on StoreHomeScreen, ModeSelectScreen, CreateStoreScreen, OnboardingHubScreen, SessionsScreen, MyDevicesScreen, RolePermissionsScreen, MoreScreen, ConflictsScreen. This is the single most common finding in the whole audit — worth a dedicated lint/sweep rather than 10 separate fixes.
- **"Coming soon" screens presented as fully live controls** — CustomersScreen's search/filter, MoreScreen's 26-of-33 unrouted menu items, PosScreen's category filter/product grid all render as interactive without being wired to anything. Undermines trust; these should be visually disabled/deferred, not just non-functional.
- **Destructive/consequential actions missing confirmation** — ConflictsScreen (P0 above) and DowngradeResolveScreen (Save with no confirm, no live limit counters) both let a high-consequence action fire on a single tap.
- **Touch targets below 44pt on repeated-tap controls** — RolePermissionsScreen's checkboxes (16px, tapped dozens of times per screen), ProductsScreen's add-button (36px).
- **Dead-end screens with no escape hatch** — StorePickerScreen (no logout/back), PersonalWorkspaceScreen (P0 above), StoreEntryScreen's not-found state (logout-only).

---

## Onboarding

### ModeSelectScreen (`apps/mobile/src/features/onboarding/screens/ModeSelectScreen.tsx`)
- **Purpose:** Force a first-time choice between "Business" and "Personal" account mode right after login.
- **Issues:**
  - [P2] Duplicate copy: "You can switch anytime from Settings" appears twice verbatim — once in the subtitle (`:203-205`) and again as a footer line (`:258-264`). Remove the footer repeat; keep it only in the subtitle.
  - [P2] Hardcoded `rgba(255,255,255,0.50/0.55)` literals (`:29-30`, used at 137/203/258) instead of a `theme.overlay.onLight*` token — violates the design-system's "never a raw rgba" rule.
  - [P2] Hardcoded shadow (`shadow-color:#000`, manual offset/opacity/radius/elevation) on the `Card` sheet (`:354-358`) instead of `theme.shadow.top`/`lg`; also `border-top-radius:28px` (`:349-350`) isn't on the `borderRadius` scale (nearest token is `xLarge`=32).
  - [P3] `LogoBox`/`IconCircle` 40×40 and `BadgeDot` 16px/3px (`:301-310`, `:316-325`, `:331-344`) are hardcoded rather than `theme.componentSizing.*`.
- **Necessity:** Remove the duplicate "switch anytime" footer line; everything else (brand row, logout, invites badge, two mode cards, inline error) earns its place for a first-run binary choice.
- **Space/layout:** The white `Card` sheet uses `flex:1` but only holds two `ModeCard` rows + a short footer — on taller phones this leaves a large dead gap below. Fix: drop `flex:1` on `Card`, wrap content in a `Column` with `justify-content:center` inside the sheet.
- **Redesign verdict:** Targeted fix — hero/bottom-sheet structure and binary-choice pattern are right; issues are token hygiene, copy duplication, and vertical centering.
- **What's good:** Clear equal-weight binary choice with per-card loading/disabled/selected states, accessible icon buttons with labels, inline error with icon, restrained gradient hero.

### CreateStoreScreen (`apps/mobile/src/features/onboarding/screens/CreateStoreScreen.tsx`)
- **Purpose:** 5-step wizard collecting store identity/contact/location/tax/hours to create a store.
- **Issues:**
  - [P1] Currency `Select` is permanently `disabled` with no explanation (`:537`) — still renders as an interactive dropdown, so users tap it expecting a picker and get nothing. Fix: render as a static read-only row ("Currency: INR — set from your account") or add an explanatory caption.
  - [P2] `CloseButton` (`:793-800`) and `BackSquare` (`:839-848`) are icon-only touchables with no `accessibilityLabel`/`accessibilityRole`, unlike every other icon button in this flow.
  - [P2] Pervasive hardcoded spacing/radius: `CloseButton` 32px, `ProgressTrack` gap 5px, `ProgressSegment` height 4px, `NavBar` padding-top 14px, `BackSquare` 52px, `NextPill` border-radius 100px, `DayChip` 44px/border-radius 22px — none from `theme.sizing`/`theme.borderRadius`.
  - [P2] Steps 2–4 (contact, location, tax/legal) are 100% optional (`STEP_META:56-77`) yet each still requires an explicit "Next" tap — 3 mandatory taps for a user who wants to skip to submitting. Consider a visible "Skip" affordance.
- **Necessity:** Nothing to remove — validation, keyboard chaining, and progressive disclosure (GST registration-type radio only shown when GSTIN entered) are all justified. Missing: a lighter "skip" path through the all-optional middle steps.
- **Space/layout:** Fine — dense but well-grouped; step 5's "same hours" mode leaves minor empty space below the day-chip row on tall screens.
- **Redesign verdict:** Targeted fix — the most standards-compliant screen in the set (dirtyFields, per-step + full-schema validation with step-jump banner, `useFieldArray`, cascading `setValue`, `beforeRemove` guard covering swipe/hardware-back). Fixes are local token/a11y/copy items.
- **What's good:** Exemplary forms-agent compliance — unsaved-changes guard on every exit vector, cross-step validation-error banner that names the field and jumps to its step, prefetched dropdown data so no mid-wizard spinners, correct keyboard chaining throughout.

### PersonalWorkspaceScreen (`apps/mobile/src/features/onboarding/screens/PersonalWorkspaceScreen.tsx`)
- **Purpose:** Landing screen for users who chose "Personal" mode — currently a placeholder ("Coming soon").
- **Issues:**
  - [P0] Dead end: the only control is "Log out" (`:13`). A user who deliberately picked "Personal" (promised on the prior screen "you can switch anytime from Settings") has no way to switch to Business or reach Settings — logging out is the sole exit, breaking that promise.
  - [P1] No header/chrome at all (no `AppLayout`, no back button, no brand row) — every other onboarding screen has consistent top chrome; this one feels foreign.
- **Necessity:** Missing and essential: a "Switch to Business" action (or link to Settings) next to Logout. Keep the honest "Coming soon" messaging.
- **Space/layout:** Entire screen is 3 centered lines in a full-bleed column, nearly all viewport empty — acceptable for a stub, but use the space for a small illustration + the missing CTA.
- **Redesign verdict:** Partial restructure — the placeholder concept is right, but it needs a header + mode-switch CTA; as shipped it's a functional trap, not just a polish gap.
- **What's good:** Honest about being unbuilt rather than faking a broken feature; correct use of `Typography`/`Column`/`Button` with zero hardcoded values — the cleanest file of the five, token-wise.

### InvitationsScreen (`apps/mobile/src/features/onboarding/screens/InvitationsScreen.tsx`)
- **Purpose:** List pending store invitations and let the user accept or decline one.
- **Issues:**
  - [P1] `ListScaffold`'s error branch fully replaces the list with a full-screen error state whenever `error` is truthy, regardless of whether invitations are already visible. Since this screen refetches on every focus (`:29-34`), a transient network blip on returning wipes already-visible invites to a scary full error page — violates this codebase's own loading-agent rule ("keep the list, don't clear on error"). Fix: only show the full error state when there's no cached data; otherwise toast + keep the list.
  - [P3] Two different error messages wired for what looks like the same condition; only one (`errorState.message`, "Couldn't load invitations") actually renders — drop the unused string (`:109-114`).
- **Necessity:** Everything present (list, accept/reject, skeleton, empty/error states) is needed; nothing to remove.
- **Space/layout:** Fine — standard header/list chrome, per-row skeletons matching the real card shape, no cramping.
- **Redesign verdict:** Targeted fix — states are otherwise correct (skeleton matches layout, pull-to-refresh, focus-refetch, confirm-before-decline with correct destructive/cancel labeling). Only the error-state data-wipe behavior needs fixing.
- **What's good:** Per-row skeleton exactly matches `InviteCard`'s shape for zero layout shift; decline flow uses a proper confirm dialog with "Decline"/"Keep editing"; refetches bootstrap after accept/reject so invite badge counts update immediately elsewhere.

### OnboardingHubScreen (`apps/mobile/src/features/onboarding/screens/OnboardingHubScreen.tsx`)
- **Purpose:** Landing gate for authenticated users with no store yet — primary action "Create your store"; secondary is checking invitations.
- **Issues:**
  - [P1] For a user with pending invites, the only cue is a tiny badge dot on a header mail icon (`:245-276`) while the entire headline and full-width CTA push exclusively toward creating a new store — easy to miss. Fix: when `hasInvites` is true, render a visible banner/card above the CTA ("You have {n} pending invitation(s) — View").
  - [P2] Hardcoded style values throughout: `IconCircle` 40px, `BadgeDot` dimensions, `SlideCard` border-radius 20px + raw shadow, `PillButton` padding-vertical 16px, `Carousel` height built from raw `CARD_HEIGHT+56` — none from theme tokens.
  - [P2] The marketing feature carousel plays on every visit, including repeat visits (e.g. a user bounced back here after declining an invite re-watches the same pitch). Consider gating it to first visit.
- **Necessity:** Missing: a first-class invitations entry point when `hasInvites`. Keep: carousel on first visit only; "Create your store" CTA is correctly the single primary action otherwise.
- **Space/layout:** Generally fine — carousel vertically centered, title/CTA anchored near the bottom within thumb reach.
- **Redesign verdict:** Targeted fix — layout and primary-CTA placement are right; the real fix is surfacing invitations as a first-class element for invited users, plus token cleanup.
- **What's good:** Well-built animated carousel (autoplay pauses on drag/blur, snaps correctly), prefetches the create-store wizard's dropdown data ahead of time, refetches user on focus, single clear bottom CTA anchored for thumb reach.

---

## Store home & picker

### StoreEntryScreen (`apps/mobile/src/features/store/home/screens/StoreEntryScreen.tsx`)
- **Purpose:** Deep-link/resume entry point that resolves a `storeId`, claims this device's store-access slot, and lands the user in the store (or bounces them out safely).
- **Issues:**
  - [P1] The `notFound` state (`:48-56`) offers only "Log out" — a user who still has other valid stores is forced to fully re-authenticate just to reach a store list they already have access to. Fix: add a primary "Go to my stores" button alongside a secondary "Log out."
  - [P2] The blocked/claim-failed path shows only a bare loader with zero copy (`:61`), then silently redirects to the picker (`:43`) — a dismissed alert leaves an unexplained jump. Fix: a one-line transient toast on arrival at the picker when redirected this way.
- **Necessity:** Nothing to remove; "Go to my stores" is the missing essential.
- **Space/layout:** Fine — full-bleed loader and centered 3-element error state are appropriate for this transitional screen.
- **Redesign verdict:** Targeted fix — resolve → claim → redirect structure is correct; only the notFound CTA needs the added action.
- **What's good:** Single-attempt guard prevents double-claims; loader matches the native splash for a seamless boot feel.

### StoreHomeScreen (`apps/mobile/src/features/store/home/screens/StoreHomeScreen.tsx`)
- **Purpose:** The store dashboard (Home tab) — orient the user in the active store and launch its core jobs (sell, add products, view customers).
- **Issues:**
  - [P1] The notification bell (`:87-94`) routes to `MoreDetailScreen`, a generic "Coming soon" stub — a prominent, always-visible header icon that does nothing real. Fix: remove until notifications exist, or show disabled/dimmed.
  - [P2] The hero "Today's sales" and "Products" tiles are tappable and navigate to POS/Products (`:116,133`), but Quick Actions directly below duplicates the identical navigation (`:156-180`) — redundant controls for the same two actions. Fix: make hero metrics non-interactive stat display only; keep Quick Actions as the single set of entry-point buttons.
  - [P2] Hardcoded inline styles violate the "no inline style, no hardcoded values" rule: `letterSpacing:-0.3`, `maxWidth:180`, repeated `textAlign:'center'` — move into styled-components using tokens.
  - [P3] `AppLayout` given both `title="Home"` and `headerRow` — `title` is silently discarded whenever `headerRow` is passed; drop the unused prop.
- **Necessity:** Keep hero card and quick actions, but collapse the duplicate nav targets. The bell should be deferred until notifications ship, not shown as a live control.
- **Space/layout:** Fine overall — header, hero card, quick actions, and recent-products give good rhythm for a zero-data store.
- **Redesign verdict:** Partial restructure — layout/hierarchy is right, but the duplicate-action pattern and dead notification affordance need resolving together.
- **What's good:** Deliberate, well-reasoned scope-trimming (dropped faked metrics/sections that don't exist yet per the file's own doc comment) — honest "only show what's real" empty-state approach; consistent card/border/radius language throughout.

### StorePickerScreen (`apps/mobile/src/features/store/home/screens/StorePickerScreen.tsx`)
- **Purpose:** Force a choice when the account has more than one store and no remembered "last opened" store.
- **Issues:**
  - [P1] No escape hatch: `AppLayout` called with no `onBack`/`leftElement` (`:38`), and since every route into this screen uses `router.replace`, there's typically no prior screen to return to and no logout affordance. Fix: add a header action or text link — "Log out."
  - [P2] No empty-state handling: `storeLocations.map(...)` (`:44-62`) has no length check — an empty list shows only the caption over blank space. Fix: add an empty state ("No stores available — contact your account owner").
- **Necessity:** Everything shown is needed; the missing essential is the log-out/escape action.
- **Space/layout:** Fine for the populated case; would be awkward only in the unhandled empty case above.
- **Redesign verdict:** Targeted fix — the core pattern (list + tap-to-claim + overlay loader) is correct and well-handled; needs the escape hatch and empty-state guard.
- **What's good:** `OverlayLoader` with `timeoutMs` + `onCancel` (`:70-75`) blocks double-taps during the network claim but still gives an out if the call hangs; store rows show real names, never raw IDs.

---

## POS & products

### PosScreen (`apps/mobile/src/features/pos/screens/PosScreen.tsx`)
- **Purpose:** the cashier's core screen for finding products and building/checking out an order — the highest-stakes screen in the app.
- **Issues:**
  - [P0] No cart, no line items, no running total, no checkout action anywhere in the file — a cashier cannot ring up a sale here at all; only a search bar over a permanently empty grid exists (`:24-56`).
  - [P0] `data={[]}` is hardcoded (`:37`) — the product grid can never show a real product, so search/filter above it are non-functional theater today.
  - [P1] The category filter offers exactly one option, `'all'` (`:8-12`) — pointless until ≥2 real categories exist; remove for now.
  - [P1] `loaderProps={{isLoading:false, isFetching:false, ...}}` and `refetch:()=>undefined` are hardcoded (`:42-48`) — no loading/refresh state wired; the loading-agent's state machine is bypassed entirely.
- **Necessity:** Remove the single-option category filter now; the page is missing everything essential to its actual job — cart/line-items panel, totals, checkout CTA, barcode-scan entry.
- **Space/layout:** The whole screen is one search bar over a permanently blank state — reads as broken emptiness, not calm whitespace; once real, split into a product grid plus a thumb-reachable cart/checkout panel.
- **Redesign verdict:** Full redesign — this is a placeholder shell, not yet a POS screen; the cart/checkout structure doesn't exist to be tweaked.
- **What's good:** Correctly composed from `AppLayout`/`ListScaffold`/`SearchBar` with zero hardcoded styles; code comments are honest about the stub state.

### ProductsScreen (`apps/mobile/src/features/products/screens/ProductsScreen.tsx`)
- **Purpose:** browse/search the local product catalog and create new products.
- **Issues:**
  - [P0] `ProductCard` has no `onPress`/navigation — it's a plain `Column`, not a `Pressable` — tapping a product does nothing, so existing products can never be viewed or edited, only new ones created.
  - [P1] `loaderProps={{isLoading:false, isFetching:false}}` and `refetch:()=>undefined` are hardcoded (`:98-105`) — no skeleton, no pull-to-refresh; should use `useScreenState`/`ScreenStateRenderer`.
  - [P1] Price shown as raw `"₹" + sellingPrice` concatenation with no thousands separator — breaks currency formatting for real data (e.g. ₹150000 vs ₹1,50,000).
  - [P2] Add-product `IconButton` renders at `size={36}` (`:70`), below the 44pt touch-target minimum; `hitSlop={8}` (`:76`) only partially compensates.
- **Necessity:** No stock indicator is correctly deferred per the file's own comment (not implemented server-side yet). Missing essential: tap-to-view/edit on the product card.
- **Space/layout:** Cards carrying only two short text lines in a grid built for imagery leave awkward empty space per cell; add a small leading icon/avatar for rhythm or switch to a denser text-row list.
- **Redesign verdict:** Targeted fixes — search + grid + FAB structure is right; the gaps are the missing card tap action, price formatting, and loading-state wiring.
- **What's good:** Reactive local data via `useLiveQuery` with debounced search/render, RBAC-gated add button, well-designed empty/error/no-match states, no hardcoded styles.

### CreateProductScreen (`apps/mobile/src/features/products/screens/CreateProductScreen.tsx`)
- **Purpose:** add a new product to the local catalog via an offline-first enqueued write.
- **Issues:**
  - [P1] No cross-field validation between `sellingPrice`/`costPrice`/`mrp` — a user can save MRP lower than selling price or cost above selling price with no warning; add a `.refine()` per the forms standard.
  - [P1] The `trackInventory` switch (`:106-111`) has no dependent initial-stock-quantity field anywhere — toggling it on visibly does nothing; either add a conditional field or remove the switch.
  - [P2] Money inputs have no visible ₹ prefix/adornment inside the field — currency is only implied via placeholder text.
  - [P2] All six fields plus the switch render as one flat, ungrouped list mixing identity fields (name/sku/barcode) with pricing fields — group under "Identity" and "Pricing" `SectionHeader`s.
- **Necessity:** Everything present earns its place for a minimal create flow; missing (if `trackInventory` matters) is the initial-stock field — flag as an open product question.
- **Space/layout:** Fine — a single flat column for 6 fields is acceptably simple, though the Identity/Pricing grouping above would improve scan order.
- **Redesign verdict:** Targeted fix — structurally correct (FormScreen's anatomy, full keyboard chaining, `FormFieldAnchor` scroll-to-error); gaps are additive validation and field grouping.
- **What's good:** Fully compliant with the forms standard — flat schema, full keyboard chaining, `Input`/`Switch` wired to RHF correctly, offline-first submit correctly skips server-error branching with a clear comment explaining why.

---

## Customers, sessions & devices

### CustomersScreen (`apps/mobile/src/features/customers/screens/CustomersScreen.tsx`)
- **Purpose:** browse/search/filter customer records and add a new customer.
- **Issues:**
  - [P0] The "+ Add customer" button has no `onPress` at all (`:29-43`) — tapping the screen's one primary action does nothing, with zero feedback.
  - [P1] `SearchBar` and its balance filter (`:26-27, 47-55`) render as fully live controls but have no data to act on (`data={[]}` hardcoded) — typing or changing the filter visibly does nothing, reading as broken rather than "not built." Fix: hide the search/filter bar entirely until the feature ships.
  - [P2] The empty-state title "No customers yet" still reads as "this store has zero customers" at a glance despite an honest description below it — consider leading with "Coming soon" as the title.
- **Necessity:** Whole screen is currently a shell with no data layer — question whether the Customers tab should even be reachable yet; if kept, strip interactive chrome down to a single "coming soon" message.
- **Space/layout:** Structurally fine, but effectively all the screen's real estate is spent on chrome for a feature that can never show data yet.
- **Redesign verdict:** Partial restructure — the eventual layout (search + filter + list) is right for when data lands, but everything interactive needs to be removed/disabled for the current no-op state.
- **What's good:** Correct composition of `AppLayout`/`ListScaffold`/`SearchBar`, accessible `IconButton`, honestly-worded empty-state description.

### SessionsScreen (`apps/mobile/src/features/store/sessions/screens/SessionsScreen.tsx`)
- **Purpose:** show where the user is logged in across devices and let them log out the current device or revoke another session.
- **Issues:**
  - [P1] Hardcoded style literals bypass design-system tokens: `border-left-width:3px` (line 188) should be `theme.borderWidth.medium`; `44px`/`28px` on `IconSlot` and `8px 14px` padding on `LogOutButton` aren't sourced from theme sizing at all.
  - [P2] `theme.colorFillSecondary ?? theme.colorBorder` (line 203) is a needless fallback — `colorFillSecondary` is always defined.
  - [P2] `ScreenStateRenderer` (lines 86-93) passes no `emptyTitle`/`emptyDescription`, so a zero-sessions edge case falls back to nonsensical generic copy.
  - [P3] Both current-device and other-device rows use identical "Log Out" copy despite differing scope (local+server logout vs. remote-only revoke) — distinguish the label.
- **Necessity:** Everything shown earns its place. Missing: no location/IP context on a session — flag as a product question since it may not exist in the API today.
- **Space/layout:** Fine — consistent gaps and card padding, no cramping.
- **Redesign verdict:** Targeted fixes — structure and hierarchy are correct; only token cleanup and copy tweaks needed.
- **What's good:** Correct `ScreenStateRenderer` (skeleton/error/retry) usage, proper `RefreshControl` gating, per-row `busyId` dimming instead of a full-screen spinner, `Alert.confirm` used correctly for destructive actions.

### MyDevicesScreen (`apps/mobile/src/features/store/devices/screens/MyDevicesScreen.tsx`)
- **Purpose:** view devices registered to the user across stores and block/unblock a device for security.
- **Issues:**
  - [P1] Entire device card is one `onPress` that jumps straight into a "Block this device?" confirm modal — a destructive, security-sensitive action is one accidental tap away, with no intermediate menu/affordance step.
  - [P1] Each row ends in a `ChevronRight` — the universal "drill into detail" affordance — but tapping opens the block/unblock dialog instead of a detail screen; mismatched visual promise vs. behavior.
  - [P1] Same hardcoded-value violations as Sessions: `border-left-width:3px`, `44px`/`28px` literals not sourced from theme tokens.
  - [P3] The blocked-device card still shows the same misleading `ChevronRight` even though its only action is reopening the unblock dialog.
- **Necessity:** Active/blocked sections, tags, and store count all earn their place. Missing: no timestamp/reason on a blocked device, no bulk "sign out all other devices" action — worth considering, not a defect.
- **Space/layout:** Fine — matches Sessions' rhythm, no cramping.
- **Redesign verdict:** Partial restructure — the row/action model needs to change (chevron → explicit action, whole-row-tap → deliberate control for a destructive action); grouping/density/states stay as-is.
- **What's good:** Rich, honest confirm-dialog copy spelling out exactly what blocking does; per-device tags (current/trusted/blocked); per-row `busyId` dimming; correctly supplies `emptyTitle`/`emptyDescription` (unlike Sessions).

---

## Staff & roles

### InviteStaffScreen (`apps/mobile/src/features/store/staff/screens/InviteStaffScreen.tsx`)
- **Purpose:** Invite a person by phone number to a custom role for the current store.
- **Issues:**
  - [P1] Dead end when no role exists to pick: the empty-state message is text-only with no path forward. Fix: add an inline "Create a role" CTA in the empty state that routes to role creation.
  - [P2] Inconsistent field hierarchy: the contact field gets a bold heading ("Who are you inviting?") but the Role field below has no heading at all.
  - [P2] No role-permission preview: user picks a role by name only, with zero indication of what it grants.
- **Necessity:** The two fields are exactly what's needed; missing is a way to create a role from this screen when none exist.
- **Space/layout:** Fine — generous gap between field groups, no cramping.
- **Redesign verdict:** Targeted fix — structure and fields are correct, issues are local (empty-state CTA, heading consistency).
- **What's good:** Contact field is never blocked by role-loading (isolated to the dropdown); `mapError` correctly handles `invitation_already_pending`/`user_limit_reached` per the forms-agent precedence.

### RolesListScreen (`apps/mobile/src/features/store/roles/screens/RolesListScreen.tsx`)
- **Purpose:** Browse the store's roles (custom + system) and enter either role creation or a role's permission matrix.
- **Issues:**
  - [P2] System vs. custom roles look identical except for a small "System" tag — same icon, same card weight for a role you can edit vs. one you can't. Fix: mute the card when `is_editable === false`.
  - [P3] No search/filter as the roles list grows.
- **Necessity:** Nothing to remove; permission-gated create button is correctly shown only to those who can act on it.
- **Space/layout:** Fine — standard list/card spacing.
- **Redesign verdict:** Targeted fix — only the system-role visual distinction needs work.
- **What's good:** Full loading/empty/error/refresh state coverage, correctly passing `isRefetching` (not `isFetching`) to avoid a spurious pull-to-refresh spinner; empty state has message + description + CTA.

### CreateRoleScreen (`apps/mobile/src/features/store/roles/screens/CreateRoleScreen.tsx`)
- **Purpose:** Create a custom role (name + optional description) as the first step before configuring its permission matrix.
- **Issues:**
  - [P2] No on-screen warning that tapping Create immediately drops the user into a full ~25-row permission matrix — the intent is explained only in a code comment. Fix: add a caption hint ("Next, you'll choose what this role can do").
  - [P3] Two-field form leaves noticeable empty space below the text area on larger screens — the hint above would double as a fix.
- **Necessity:** Name + description are exactly what's needed; missing is the "what happens next" hint.
- **Space/layout:** Mildly empty below the two fields; fill with the hint rather than leaving it blank.
- **Redesign verdict:** Targeted fix — the fields and flow are correct.
- **What's good:** Correctly reuses `FormScreen` (autoFocus, keyboard chaining, server error mapped to the `name` field for `role_already_exists`); one schema, no duplicated create/edit forms.

### RolePermissionsScreen (`apps/mobile/src/features/store/roles/screens/RolePermissionsScreen.tsx`)
- **Purpose:** View/edit one role's CRUD grants across every entity type in the store; read-only for system roles or users without `Role:edit`.
- **Issues:**
  - [P1] Flat, ungrouped scroll of ~25 near-identical entity cards with no section headers or search — finding one entity means scanning the whole list every time. Fix: group into logical sections (Sales, Inventory, People, Admin) and/or add a filter bar.
  - [P1] No bulk grant/revoke: building a broadly-privileged role means tapping "Full access" up to 25 separate times — add a header-row "Grant all / Clear all."
  - [P2] Hardcoded spacing literals bypass tokens (`gap={8}`, `gap={16}` passed as raw numbers rather than token keys).
  - [P2] Undersized touch targets: every checkbox uses `size={16}` with no `hitSlop`, well under the ≥44pt ergonomic minimum for a control tapped dozens of times per screen.
  - [P3] The read-only caption scrolls away with the list instead of staying visible.
- **Necessity:** Every element earns its place — this is a real matrix, not clutter. Missing: grouping, search, and bulk-select, essential once entity count exceeds a screenful (it already does, at 25).
- **Space/layout:** Individual rows are correctly spaced, but 25 undifferentiated rows read as repetitive cramping rather than a designed hierarchy — a grouping problem, not a whitespace problem.
- **Redesign verdict:** Partial restructure — the card + checkbox pattern is right and should stay, but 25 ungrouped rows with no search/bulk-select is the wrong information architecture at this scale.
- **What's good:** Dependent-permission propagation correctly prevents invalid states (e.g. delete without view); hand-rolled unsaved-changes guard correctly diffs against the server-seeded baseline; combined loading/error handled once for the two dependent queries.

---

## Subscription

### SubscriptionScreen (`apps/mobile/src/features/store/subscription/screens/SubscriptionScreen.tsx`)
- **Purpose:** Show current plan, status, usage limits, and billing entry points; route to Plans or the downgrade-resolve flow.
- **Issues:**
  - [P1] Hero CTA label ignores billing status: shows "Upgrade" even when status is `past_due`/`expired`, right under a "Payment failed" banner. Fix: status-aware label ("Renew now" / "Change plan" / "View plans").
  - [P1] Reconciliation banner and the upgrade/status banner have no precedence and can both render stacked, doubling urgent-red messaging.
  - [P2] The catch-all banner copy ("Action needed on your subscription") tells the user nothing to act on.
  - [P3] The plan-period progress bar is explicitly "decorative precision, not billing truth" per its own comment — a precise-looking bar for a fabricated fraction risks distrust; drop it, keep the "N days left" text.
- **Necessity:** "Billing & invoices"/"Payment method" rows correctly use the sanctioned disabled "coming soon" pattern. Missing: any in-app path to fix a failed payment when `past_due` — currently only "Upgrade" exists.
- **Space/layout:** Fine — hero card, limits card, billing menu read calm and well-grouped.
- **Redesign verdict:** Targeted fix — structure is right; fixes are copy/label logic and banner precedence.
- **What's good:** Layout-matched skeleton, pull-to-refresh wired correctly, reconciliation banner links straight into the resolve flow, entitlements list handles "Unlimited" gracefully.

### SubscriptionPlansScreen (`apps/mobile/src/features/store/subscription/screens/SubscriptionPlansScreen.tsx`)
- **Purpose:** Compare plans under one Monthly/Annual toggle and start an upgrade/downgrade.
- **Issues:**
  - [P1] When a plan has no pricing for the selected cycle, its whole action area renders `null` — a card with no button and no explanation. Fix: render a disabled state with copy ("Not available on annual billing").
  - [P2] Zero-price fallback hardcodes `"₹0 forever"` regardless of the plan's real currency. Fix: derive currency from the plan's pricing, or use plain copy "Free forever" with no symbol.
- **Necessity:** Everything present earns its place. Missing: no link to a full feature-comparison view when highlights alone don't cover a deciding factor.
- **Space/layout:** Fine — toggle + cards + trust row is a natural single-column scroll with even rhythm.
- **Redesign verdict:** Targeted fix — only the empty-CTA-card case and currency fallback need addressing.
- **What's good:** One global cycle toggle instead of per-card toggles reduces repetition; recommended badge and current-plan treatment are visually distinct; a confirm sheet interposes a review step before checkout; skeleton matches the card layout closely.

### SubscriptionCheckoutScreen (`apps/mobile/src/features/store/subscription/screens/SubscriptionCheckoutScreen.tsx`)
- **Purpose:** Single-purpose bridge — create the Razorpay order, hand off to the hosted WebView, and verify payment before returning to Subscription.
- **Issues:**
  - [P1] The overlay during payment verification is given no `onCancel`/`onRetry`, so once the 20s timeout fires, no button ever renders and the user is stranded on "This is taking longer than expected" with no way to retry or leave. Fix: wire `onRetry` to re-invoke verification.
  - [P2] Success/error feedback routes through a native OS `Alert` dialog, requiring an extra tap before navigating on — blocks navigation behind a modal for what should be an immediate transition.
- **Necessity:** The deliberate omission of a custom header once the WebView mounts (avoiding a duplicate back button) is good, justified minimalism. Missing: no order/plan summary visible during the initial wait.
- **Space/layout:** Fine — the loading state is centered and purpose-built, not a generic spinner.
- **Redesign verdict:** Targeted fix — flow and state handling are well thought through; only the stranded-timeout overlay and native-alert-blocking-navigation need fixing.
- **What's good:** Full overlay blocker used correctly for the one truly irreversible step, idempotent verify removes race conditions, a `started` guard prevents duplicate order creation, layout-matched initial loading state.

### DowngradeResolveScreen (`apps/mobile/src/features/store/subscription/screens/DowngradeResolveScreen.tsx`)
- **Purpose:** Let the owner choose which stores/devices to keep after a downgrade leaves the account over its new limits, to lift an account-wide write-freeze.
- **Issues:**
  - [P1] Tapping "Save" submits directly with no confirmation, even though it determines which stores/devices become locked. Fix: add a confirm step ("Keep these N stores/M devices? Everything else locks.").
  - [P1] No live counter against the plan limit while checking boxes — the over-limit check only fires at submit. Fix: show a live "X / N selected" counter per section.
  - [P1] No per-row indication of consequence — unchecking relies entirely on a one-time intro paragraph to remember "unchecked = locked." Fix: an inline "Will be locked" caption under each unchecked row.
  - [P2] Only stores are validated client-side before submit; devices' over-limit is only caught server-side, a slower feedback loop.
  - [P2] The current-device checkbox is `disabled` with no explanatory caption — visually identical to any checked box, may read as unresponsive.
  - [P3] The "time ago" helper has no month/year fallback — a device inactive for a year still prints "365d ago."
- **Necessity:** Everything on the page earns its place; live limit counters and a confirm-before-save step are the essential gaps.
- **Space/layout:** Mostly fine; unchecking a store makes its device sub-section vanish instantly with no transition — a minor abrupt collapse.
- **Redesign verdict:** Targeted fix — the list → per-row keep/lock → sticky-Save structure is correct; add confirm step, live counters, and per-row consequence text.
- **What's good:** Smart one-time seed effect (keeps the first N, current device always prioritized and un-uncheckable) gives a sensible default; explicit "nothing is deleted" framing; sticky footer keeps Save reachable; skeleton matches the section layout.

---

## More & sync

### MoreScreen (`apps/mobile/src/features/store/more/screens/MoreScreen.tsx`)
- **Purpose:** Central navigation hub to every store-admin/account feature, plus store switch and logout.
- **Issues:**
  - [P1] All 13 sections render as one flat, unlabeled list with no clustering — daily-use rows (Shifts, Sales) sit visually equal to rare ones (Developer, Subscription). Fix: group into 3 labeled clusters ("Operations," "Customers & Finance," "Admin & Account").
  - [P1] Only 7 of 33 leaf menu items resolve to a real screen — 26 items (79%) dead-end at "Coming soon," with no signal before tapping. Fix: add a "Coming soon" tag on unrouted rows, or don't ship them yet.
  - [P2] Inline style overrides instead of styled/token props (`style={{ backgroundColor: ... }}`, `style={{ flex: 1 }}`).
  - [P3] A "teal" icon color silently renders as blue — visually indistinguishable from `info`-colored items in the same lists.
- **Necessity:** Every section is plausibly needed eventually, but showing all 33 items as if live today is premature — defer/badge the 26 unbuilt ones. Missing: any build-status indicator per row, and no search across 13 sections.
- **Space/layout:** Fine locally, but the page is a very long undifferentiated scroll for a "hub" screen — the fix is grouping, not whitespace.
- **Redesign verdict:** Partial restructure — drill-down model is right, but the flat 13-section top level needs clustering and unbuilt items need visual honesty.
- **What's good:** Gradient store card with inline "Switch Store" affordance; `__DEV__`-gated Developer section; logout uses a correctly-labeled destructive confirm; live sync-issue badge surfaced right on the hub row.

### MoreSectionScreen (`apps/mobile/src/features/store/more/screens/MoreSectionScreen.tsx`)
- **Purpose:** Level-2 list of items within one chosen section (e.g., "Sales" → Refunds, Promotions).
- **Issues:**
  - [P2] "Section doesn't exist" fallback is a bare centered sentence with no icon/CTA beyond the header back chevron. Fix: use the catalogued empty-state component with a "Go back" button.
  - [P2] Inherits MoreScreen's unbuilt-item problem — same items dead-end here with no upfront signal.
  - [P3] The section's own description is dropped once drilled in — only the title is shown.
- **Necessity:** Content shown is all relevant; missing is a subtitle restating the section description, and a per-row "coming soon" indicator.
- **Space/layout:** Fine — small item counts fit comfortably, no cramping or excess whitespace.
- **Redesign verdict:** Targeted fix — structure is correct; only the empty/not-found state and "coming soon" signal need work.
- **What's good:** Consistent reuse of `MenuRowList` and the sync-issue badge pattern from MoreScreen — drill-down feels continuous, not foreign.

### MoreDetailScreen (`apps/mobile/src/features/store/more/screens/MoreDetailScreen.tsx`)
- **Purpose:** Shared terminal placeholder for any menu item without a built screen yet.
- **Issues:**
  - [P2] Content is two lines dead-centered in a fully empty screen — a lonely element in a vast area that can read as "something broke." Fix: add a supporting icon and/or anchor the block in the upper third instead of true center.
  - [P2] No action offered besides the header back button — the flow just stops.
  - [P3] `label`/`description` params are typed as always-present but are runtime-optional if this screen is ever deep-linked directly.
- **Necessity:** Minimal content is appropriate for this screen's own narrow job; the real problem (absorbing 79% of all menu taps) belongs to MoreScreen/MoreSectionScreen's necessity fix, not this file.
- **Space/layout:** Awkward — genuinely wasted, unstyled empty space around two lines of text; needs a small visual anchor.
- **Redesign verdict:** Targeted fix — one shared placeholder for all unbuilt destinations is the correct minimal pattern; just needs a small content/visual upgrade.
- **What's good:** Avoids 26+ duplicate placeholder screens; clean minimal copy; correctly wires the back action.

### ConflictsScreen (`apps/mobile/src/features/sync/screens/ConflictsScreen.tsx`)
- **Purpose:** Resolve sync conflicts (choose local vs. server), see rejected/failed pushes, retry stuck applies, see pending-sync count.
- **Issues:**
  - [P0] Tapping "Keep mine" or "Use server" fires the resolution immediately with no confirmation — permanently discards one side of the data with zero undo, while the app's own logout flow (lower stakes) does confirm. Fix: wrap both in a confirm dialog naming what will be discarded.
  - [P0] The conflict card shows only a single summarized value per side, and for entities without a `name` field (stock adjustments, purchase orders, price/quantity edits), both sides can render the identical string or an unreadable GUID — the user has no visible basis to choose. The underlying row component supports a per-field diff display, but it's never wired up.
  - [P1] The built-in "Inspect" drill-down is never wired — no way to see full record detail even for a determined user.
  - [P1] No explanatory copy anywhere for why a conflict happened or what each button does — first-time users hitting this rare flow get a bare header and two buttons.
  - [P1] Rejected rows have no dismiss/acknowledge action, unlike failed rows — a permanently-rejected mutation sits under "Couldn't be sent" indefinitely.
  - [P2] Hardcoded, untethered gap magic numbers (e.g. `10`) that match no theme token.
  - [P2] Inline style + hardcoded literals for border/gap, inconsistent with the token-based pattern used elsewhere.
  - [P3] The "busy" state for dismissing a failed row disables the Dismiss button on all other failed rows too, not just the one in flight.
- **Necessity:** All four sections (pending/conflicts/rejected/failed) are correctly scoped. Missing: per-field diff content, an explanatory line, and a dismiss action for rejected rows.
- **Space/layout:** Mostly fine — virtualized list with reasoned gap constants; no cramping. One gap: no total-issue count in the header, so a returning user must scroll all 4 sections to confirm nothing's left.
- **Redesign verdict:** Targeted fix — the structural approach (single virtualized list, 4 named sections, per-row busy scoping, catch-wrapped handlers) is sound; fixes are local but include two P0s (real diff data, confirm before destructive resolve).
- **What's good:** Virtualization choice is justified and correct for an unbounded queue; per-row scoping avoids cross-row interference; every handler is try/catch-wrapped with a toast fallback; reactive live-query keeps counts current; the sync-issue badge on the More-tab entry gives an ambient signal before the user even opens this screen.

---

## Notes

- Two screens were intentionally excluded from this review: `LocalTablesScreen` and `LocalTableDetailScreen` (internal developer/debug tooling, not part of the enterprise end-user surface).
- Several P0/P1 findings above (ProductsScreen card tap, CustomersScreen add button, MoreScreen's 26 unbuilt destinations) point to features that are genuinely mid-build rather than regressions — the fix in those cases is either finishing the wiring or being honest in the UI that the feature isn't live yet, not necessarily a design change.