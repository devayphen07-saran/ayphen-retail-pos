# Mobile Architecture · Part 3 — Post-Login Flow & Navigation

> Part of the [Mobile Post-Login & Freshness](./MOBILE_POST_LOGIN_AND_FRESHNESS.md) series.

---

## 4. Post-login flow (ordered)

| # | Trigger | Call | Reads | Stores | → Route |
|---|---|---|---|---|---|
| 0 | cold start (pre-auth) | `GET /time`; `GET /auth/mobile/app-version` | clock; `forceUpdate` | memory | force-update if needed |
| 1 | login stage 2 ok | — | tokens, user | **SecureStore**: tokens | — |
| 2 | tokens stored | `GET /me/bootstrap` | full bootstrap | verify+store snapshot (SecureStore→memory); preferences/subscription in memory | branch ↓ |
| 3a | `maintenance_mode` | — | — | — | /maintenance |
| 3b | `profile_status=incomplete` | later `PATCH /me {name}` | `missing_fields` | — | /onboarding/complete-profile |
| 3c | `last_account_mode` | later `PATCH /me/account-mode` | mode | — | null → mode chooser; set → auto-route (see 3d) |
| 3d | mode resolved | — | account_mode | — | **PERSONAL → personal workspace (stop here, no store needed)**; **BUSINESS → step 4** |
| 3e (BUSINESS, `stores[]` empty) | branch on invitations (§8D.3) | `pending_invitations` / `has_pending_invitations` | — | pending → /invitations (accept → step 4); else `POST /stores` → /onboarding/store-setup |
| 4 | resolve active store (no network) | — | `last_opened ?? default ?? (single→open / multiple→picker)` (§8B.4) | memory: activeStoreId | open store, or /store-picker when no pointer & multiple |
| 4b | active store chosen | `PATCH /me/preferences {last_opened_store_id}` | — | persisted | — |
| 5 | active store chosen (**online only**) | `POST /stores/:id/access` | granted / 403 limit | — | /device-limit on 403; **offline reopen skips this, uses prior claim** |
| 6 | slot granted | `GET /stores/:id/context` | hours, sync_config | SQLite/memory | — |
| 7 | subscription (client) | read snapshot | status, banner_severity | — | /subscription if blocked |
| 8 | shift gate (**store-config**, not role) | local | `enforce_open_shift_before_sale` | SQLite | POS loads; **selling** requires an open shift only when the store enforces it → Open-Shift (shifts PRD §12/§15B) |
| 9 | first open → cold sync; returning → delta | first time: loop `GET /stores/:id/sync/initial` until `all_entities_complete`; else `GET /sync/changes` (§8) | upserts, cursors | **SQLite** (all entities) | / (POS) with progress |
| 10 | steady state | `GET /sync/changes` + `POST /sync/delta` | changes/results | SQLite | /pos |

> Note: there is **no POS/order/shift-session REST API**. Sales, shift open/close
> (with cash float), and stock are created locally and pushed via `/sync/delta`.
> Full mode/empty-state product flow: §8D. Active-store resolution: §8B.4.

> **Store context is store-scoped, not user-scoped.** `bootstrap` (step 2) carries only **user-level**
> identity — who you are, which stores you can reach, account mode. Everything that belongs to *a store* —
> store-config (`enforce_open_shift_before_sale`), business hours, **feature flags, tax settings**,
> `sync_config` — loads at **store-open** (step 6 `GET /stores/:id/context`), and re-loads on every store
> switch. This keeps bootstrap small and constant-size regardless of store count (mobile-01 §Scale note),
> and means switching stores swaps a fresh context rather than re-fetching the user. **Don't fold
> store-scoped config into bootstrap.**

**Loading per step** (treatments from [mobile-08 §13](./mobile-08-loading-ux-states.md) — A–E; rules live there):

| Step | Loading |
|---|---|
| 0 pre-auth | **A** native splash; `forceUpdate` → **wall** |
| 1 login | **E** inline button spinner |
| 2 bootstrap (cold, no cache) | **C** app-shell skeleton · (warm cache) → **no loader** |
| 3a–3e gates / forms | instant (from bootstrap) · form submits → **E** button spinner |
| 4 resolve active store | **none** (no network) · ambiguous → store-picker |
| 5 `/access` | **C** brief POS-shell · `403` limit → **modal/B** |
| 6 context | **C** (folds into POS-shell) |
| 7 subscription gate | **banner/modal** (not a loader) |
| 8 shift gate | **E** Open-Shift (only if `enforce_open_shift_before_sale`) |
| 9 first cold sync | **B** until Groups 1–3 → unlock POS, background the rest · returning → **D** delta |
| 10 steady state | **D** ambient — never block |

---

## 8D. Post-login navigation — mode, store resolution & empty states (product flow)

### 8D.1 Core distinction — accepted store vs pending invitation
- **Accepted/accessible store** = appears in `snapshot.stores[]` (owned *or* an accepted
  invitation). This is what can be opened.
- **Pending invitation** = in `pending_invitations[]`, **not** in `snapshot.stores[]`. Must
  be accepted (`POST /invitations/:token/accept`) first — acceptance bumps
  `permissionsVersion`, so the store appears in the next snapshot.

So "has an invited store" = **accepted**. The empty-business state is
`snapshot.stores[]` empty — *then* check `pending_invitations[]`.

### 8D.2 The flow
```
Login success
  └─ profile_status incomplete?  → complete-profile (set name)
  └─ account_mode:
        • null  → show Business / Personal chooser
        • set   → auto-route to last mode (offer a switch, don't force the chooser)

  ┌─ PERSONAL  → personal workspace (expenses/budgets) — no store needed
  │
  └─ BUSINESS:
        activeStore = last_opened ?? default                   (§8B.4 resolution)
        • activeStore resolves            → open it (POS)
        • no pointer & 1 store            → open that store
        • no pointer & >1 store           → STORE PICKER (don't auto-pick stores[0])
        • snapshot.stores[] EMPTY:
              ├─ pending_invitations exist → INVITATIONS screen (accept → store joins → open)
              └─ no pending invitations    → CREATE-STORE form (onboarding)
```
Note: `POST /stores/:id/access` (device-slot claim) is **online-only** — on an offline
reopen of a cached store, skip it and proceed on the prior claim + local data.

### 8D.3 Empty state — invitations vs create (the rule)
**Invitations take priority whenever any are pending.** Reasons: the user was explicitly
invited (joining is expected); creating a store when invited is usually a duplicate. The
invitations screen still carries a secondary **"Create your own store"** CTA. Only when
**no** pending invitations exist → go straight to the create-store form.

> Precise rule: `snapshot.stores[]` empty → `pending_invitations` present →
> **Invitations screen** (with secondary create CTA); else → **Create-store form**.

### 8D.4 Where invitations appear (three places)
1. **Entry gate** — business mode with no accessible store but pending invitations.
2. **Persistent non-blocking surface** — once the user has stores, show a **badge/count**
   (from `has_pending_invitations` / `pending_invitations.length`) + an **"Invitations" tab**
   in the business workspace, so extra invites can be accepted anytime without blocking POS.
3. **Global indicator (NOT mode-scoped)** — a user whose `last_account_mode === 'personal'`
   auto-routes to the personal workspace and would otherwise **never see their first store
   invitation**. So surface the pending-invitation indicator **globally** (mode chooser / a
   global notification), not only inside the business workspace. A first store invite is
   important enough to cross the mode boundary.

### 8D.5 Backend support
| Step | Backend |
|---|---|
| Business/Personal mode | `last_account_mode` + `PATCH /me/account-mode {mode}` ✓ |
| Store resolution | `last_opened ?? default ?? stores[0]` — ✅ already cascades correctly (`bootstrap.service.ts:362-381`); remaining: return full `active_store` object + locked-aware (§8B.4) |
| Empty vs has-stores | `snapshot.stores[]` ✓ |
| Pending invitations | `pending_invitations[]` in bootstrap ✓ |
| Accept invitation | `POST /invitations/:token/accept` (or `/by-id/:id/accept`) — bumps pv ✓ |
| After accept → store appears | pv bump → re-bootstrap / new snapshot → store in `stores[]`; set as `last_opened`, open ✓ |
| Create store | `POST /stores` (no permission needed, onboarding) ✓ |
