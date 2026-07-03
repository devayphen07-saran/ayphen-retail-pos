# Mobile Architecture · Part 8 — Loading & UX States (enterprise-grade)

> Part of the [Mobile Post-Login & Freshness](./MOBILE_POST_LOGIN_AND_FRESHNESS.md) series.

---

## 13. Loading & UX states (enterprise-grade)

**Governing principle — offline-first means almost nothing should block.** Data lives in SQLite
and the snapshot is cached, so there is *usually* usable content to render immediately. A
full-screen blocking loader is justified **only** when there is no usable content *and* the user
cannot proceed. Benchmarked against enterprise offline apps (Square/Shopify POS, Slack, Gmail
offline, Linear, Salesforce Field Service, SAP Fiori).

### 13.1 The five loading treatments
| Treatment | When | Looks like |
|---|---|---|
| **A. Native splash** | app boot, ms | OS splash |
| **B. Full-screen blocking** (determinate if counts known) | no usable content **and** cannot proceed | branded spinner / progress |
| **C. Skeleton / app-shell** | layout known, content loading | shimmer placeholders (prefer over blank spinner) |
| **D. Ambient / non-blocking** | background work behind a usable screen | **persistent** status chip, top-bar, pull-to-refresh |
| **E. Optimistic** (not a spinner) | user writes | instant local apply + queue; rollback on reject |
| *(not a loader)* **wall / banner / modal** | error / entitlement / version | force-update wall, subscription banner, device-limit modal |

### 13.2 Decision rule
```
Usable cached content for the target screen?
  YES → never full-screen. Render content + (D) ambient indicator.
  NO  → (B) full-screen only until MINIMUM-VIABLE data exists, then unlock + background the rest.

Routing-gate decision (don't know where to send the user)?   → (B), but prefer (C) app-shell skeleton.
Single user write?                                            → (E) optimistic (NOT a blocking spinner).
Irreversible financial action (refund, void, large cash)?    → (E)+explicit confirm/spinner (the ONE exception).
Error / entitlement / version state?                          → wall / banner / modal, NOT a loader.
Operation likely < ~300–500ms?                               → show NOTHING (anti-flash delay).
```

### 13.3 Per-scenario matrix
| Flow | Treatment |
|---|---|
| App boot | **A** native splash (ms) |
| Pre-auth `/time` + `/auth/mobile/app-version` | stays on **A**; `forceUpdate` → **wall** |
| Login send/verify OTP | **E**/inline button spinner |
| **Cold launch, logged in, no cached snapshot → `/me/bootstrap`** | **C app-shell skeleton** (chrome + placeholders) while the routing gate resolves; not a blank spinner |
| **Warm launch (cached snapshot)** | **no loader** — render last screen from cache; `/me/pv` in **D** background; pv changed → pull + re-gate silently |
| Mode chooser (Business/Personal) | instant (in bootstrap) |
| Complete-profile / account-mode forms | **E** button spinner on submit |
| **After store create (`POST /stores`) / accept invite** | **B full-screen setup wizard** with progress (create + first cold sync) — first-run setup is the accepted full-screen case → land on POS |
| `POST /stores/:id/open` | **C** brief POS-shell skeleton while the one request returns |
| **First cold sync of a store** | **B** only until **Groups 1–3** (config + catalog) are in → **unlock POS**, finish Groups 4–5 in **D** background banner. *Do NOT block to 100%.* |
| **Store switch → cached target** | **instant, NO loader** (anti-flash); delta in **D** background |
| **Store switch → un-cached target** | **content-area loading within the nav chrome** (scoped, cancelable) — **not** a full-screen takeover |
| **Steady-state delta** (`/sync/changes`, `/sync/delta`) | **D ambient only — never block** |
| All POS writes (sale, add item, customer…) | **E optimistic** — instant local + queue; ambient sync; rollback toast on `rejected`/`conflict` |
| Refund / void / large cash | **E + explicit confirmation** (the one place blocking is correct) |
| Offline → online reconnect | **D** persistent status chip flips Offline→Syncing→Synced |
| Permission change (snapshot swap) | **D / silent** re-gate; optional toast "Permissions updated" |
| Account revoked / suspended / device blocked (`403 user_*`) | **wall** "Session ended" → login (wipe SecureStore) |
| Token refresh on `401 token_expired` | **silent**; at most the triggering action's spinner; hard-fail → logout wall |
| Subscription write blocked (`402`/`403`) | **banner/modal** "Renew" — reads keep working |
| Device limit (`403` on `/access` or `/open` ✅ — both live) | **modal** with device list to manage |
| Maintenance (`503` / `maintenance_mode`) | **wall** |
| Lazy data (invitations, hours, logos, plans, devices, media) | **C** section skeleton / inline — never full-screen |
| Any list/detail reading SQLite | instant (local); **C** skeleton only if empty & sync in flight |

### 13.4 The five enterprise-grade defaults (what makes it enterprise, not mid-tier)
1. **Optimistic writes** — never a blocking spinner on a normal write; apply locally + queue +
   rollback on reject (Square/Shopify POS, Linear). Spinner/confirm only for irreversible
   financial actions.
2. **Unlock-early cold sync** — block only to minimum-viable (Groups 1–3), then background the
   rest (Salesforce Field Service "briefcase", SAP Fiori prioritized sync). Never block to 100%.
3. **Persistent ambient sync status** — a status chip in the chrome (Offline / Syncing / Synced +
   pending count), not transient toasts (Gmail offline, Outlook, Slack, Linear).
4. **Anti-flash spinner delay (~300–500ms)** — fast ops (cached store switch, 304 warm launch)
   show **nothing**; a flashed loader feels slower (NN/g, Material).
5. **Scoped, not full-screen, store switch** — load into the content region with nav chrome
   visible and cancelable (Slack workspace / Shopify store / Salesforce org switch).

### 13.5 The only full-screen blocking moments (tightened)
After the defaults above, full-screen blocking is correct in **exactly two** cases:
1. **First-run store setup** (create / join) — a setup wizard with progress.
2. **Hard session-end** — forced logout / force-update / maintenance walls.

Everything else — cold launch (app-shell skeleton), first cold sync (unlock-early + background),
store switch (scoped/instant), all writes (optimistic), steady sync (ambient) — is **non-blocking**.
If a full-screen loader appears anywhere else, the SQLite/snapshot cache is not being used.
