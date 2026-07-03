# Shifts & Cash Management — Product Requirements (PRD)

> **App:** Ayphen Retail (React Native · Expo · offline-first POS)
> **Scope:** the operational **shift session** (register/cash session) — open, operate, close,
> reconcile — plus registers, cash movements, denomination counts, variance, blind close, reports,
> and how it links to the rota.
> **Companions:** scheduling lives in [rota-and-invitations.md](./rota-and-invitations.md);
> offline write-gating & mutation handlers in
> [backend-implementation-plan.md](./backend-implementation-plan.md).
> **Note:** this is a **greenfield design** (how it *should* work), not a description of current code.

---

## Table of contents
1. [The three "shift" concepts](#1-the-three-shift-concepts)
2. [Lifecycle overview](#2-lifecycle-overview)
3. [Registers](#3-registers)
4. [F1 — Open shift](#4-f1--open-shift)
5. [F2 — Operate (sales + cash movements)](#5-f2--operate-sales--cash-movements)
6. [F3 — Cash movements (pay-in / pay-out / drop / tip)](#6-f3--cash-movements-pay-in--pay-out--drop--tip)
7. [F4 — Close shift (count + variance)](#7-f4--close-shift-count--variance)
8. [F5 — Blind close & manager approval](#8-f5--blind-close--manager-approval)
9. [F6 — Force-close & handover](#9-f6--force-close--handover)
10. [F7 — Reports (shift / X / Z)](#10-f7--reports-shift--x--z)
11. [States & transitions (lock · count · pause)](#11-states--transitions-lock--count--pause)
11C. [F8 — Shift pause / resume](#11c-f8--shift-pause--resume)
12. [Enforce open-shift-before-sale](#12-enforce-open-shift-before-sale)
13. [Multi-register & one-open-per-register](#13-multi-register--one-open-per-register)
14. [Offline-first behaviour](#14-offline-first-behaviour)
14B. [Device crash recovery](#14b-device-crash-recovery)
15. [Link to rota & attendance](#15-link-to-rota--attendance)
15B. [Scheduled vs actual — open freely, reconcile in reports](#15b-scheduled-vs-actual--open-freely-reconcile-in-reports)
15C. [shift_event — the immutable timeline (event-sourced)](#15c-shift_event--the-immutable-timeline-event-sourced)
15D. [Immutable financial snapshot at close](#15d-immutable-financial-snapshot-at-close)
15E. [Audit log (financial config & overrides)](#15e-audit-log-financial-config--overrides)
15F. [Safe & deposit management (cash chain)](#15f-safe--deposit-management-cash-chain)
15G. [Server reconciliation / integrity job](#15g-server-reconciliation--integrity-job)
15H. [Shift notes](#15h-shift-notes)
16. [Data model (greenfield)](#16-data-model-greenfield)
17. [Screens](#17-screens)
17B. [Loading states (per flow)](#17b-loading-states-per-flow)
18. [RBAC matrix](#18-rbac-matrix)
19. [Business rules](#19-business-rules)
20. [Validation matrix](#20-validation-matrix)
21. [Real-world scenarios](#21-real-world-scenarios)
22. [Feature list by phase](#22-feature-list-by-phase)
23. [Key design decisions](#23-key-design-decisions)
24. [Backend changes required](#24-backend-changes-required)

---

## 1. The three "shift" concepts

"Shift" means three different things; "opening a shift" is the **cash-session** one.

| Concept | What it is | Where |
|---|---|---|
| **Shift definition** | a named time window ("Morning 9–2") | scheduling template (rota PRD) |
| **Shift assignment / rota** | who works which shift / day / area | scheduling (rota PRD) |
| **Shift session** (register/cash session, "open shift") | a cashier opens a drawer with a float, rings sales, closes with a count + variance | **THIS PRD** |

The first two are *planning*; the third is the *operational cash session* — the spine of POS cash control.

---

## 2. Lifecycle overview

```
REGISTER (terminal / drawer)
   │
   ▼
OPEN SHIFT ──────► OPERATE ──────────────► CLOSE SHIFT ──────► RECONCILE
opening float      sales + cash movements   count drawer        variance review
1 open/register    expected cash runs live  variance=actual−exp  shift report / Z
```

**Expected cash (live):**
`expected = opening_float + cash_sales − cash_refunds + pay_ins − pay_outs − drops`

**Variance (at close):** `variance = counted_cash − expected_cash` (positive = over, negative = short).

---

## 3. Registers

A **register** is a counter terminal / cash drawer within a store.

- **Minimal:** auto-create **one default "Cash Register"** per store on store creation.
- Fields: `name`, `is_active`, optional `carry_forward_float` (start next shift with the last close's cash).
- A store may have **multiple registers** (Phase 2) — each holds at most one open session.
- A register is the unit the shift session opens **against**.

---

## 4. F1 — Open shift

**Trigger:** cashier starts their turn / start of day. **Actor:** any member with `Shift:create`
(owner by default). **Online or offline.**

### Steps
1. Cashier → POS → **"Open Shift"** → pick a register (skip if only one).
2. Enter the **opening cash float**:
   - **Minimal:** a single amount (₹).
   - **Phase 2:** a **denomination count** (notes/coins) that sums to the float.
3. **(Optional) "This shift fulfills" picker** — show the member's scheduled rota entry as a soft hint
   and let them tag the session: `[ Morning ▾ | Afternoon | Unscheduled ]`. Defaults to the rota entry
   whose time window contains "now", else **Unscheduled**. Sets `rota_entry_fk` for attendance. **This
   never blocks** (§15B).
4. System creates a `shift_session`: `status='open'`, `opened_by`, `opened_at` (**actual** time),
   `opening_float_paise`, `register_fk`, `device_fk`, optional `rota_entry_fk`.
5. POS unlocks — sales now allowed and will link to this session.

### Rules
- **Opening is NEVER gated by the scheduled/assigned shift.** A member assigned "Morning" can open in
  the afternoon, early, late, or unscheduled — the session records the **actual** open time. The
  schedule is a plan; the session is reality (§15B).
- **One open session per register** — opening a register that already has an open session is rejected
  (`SHIFT_ALREADY_OPEN`); offer "resume" or "force-close the old one" (manager).
- The opening float is the cashier's accountability baseline.
- Optional: pre-fill the opening float from the register's `carry_forward_float`.

---

## 5. F2 — Operate (sales + cash movements)

While the shift is open, **everything links to the session** (`shift_session_fk`):
- **Sales** (cash / UPI / card / store-credit) — each order carries the session.
- **Refunds** — reduce expected cash (if cash refund).
- **Cash movements** — F3.

The POS shows a live **expected-cash** figure (unless blind mode, F5) and a transaction count.

---

## 6. F3 — Cash movements (pay-in / pay-out / drop / tip)

Non-sale cash events that change the drawer. Each: `{ type, amount, reason, by_user, created_at }`,
linked to the open session.

| Type | Meaning | Effect on expected cash |
|---|---|---|
| **pay_in** | add cash (e.g. owner adds change) | `+amount` |
| **pay_out / petty cash** | remove cash for an expense (reason required) | `−amount` |
| **cash drop** | move excess cash to the safe / back-office | `−amount` (→ store cash ledger) |
| **tip** | record a tip | tracked (config: in/out of drawer) |

### Rules
- **Reason required** for pay-out and drop (audit + fraud control).
- Permission-gated (`CashMovement:create`; large amounts → special `CashMovement:LARGE_AMOUNT`).
- Cash drops feed a **store cash ledger** (Phase 2) so the safe balance is tracked.

---

## 7. F4 — Close shift (count + variance)

**Trigger:** end of turn / end of day. **Actor:** the cashier (or a manager, F6).

### Steps
1. Cashier → **"Close Shift"**.
2. **Count the drawer** → **counted (actual) cash**:
   - **Minimal:** single amount.
   - **Phase 2:** denomination count.
3. System computes **expected cash** (formula §2) and **variance = counted − expected**.
4. **Blind close** (F5): expected/variance hidden until after submit.
5. If `|variance|` > threshold → **manager approval** required (F5).
6. Session → `status='closed'`, `closed_by`, `closed_at`, `counted_cash_paise`,
   `expected_cash_paise`, `variance_paise`. Cash is deposited / carried forward.
7. Generate the **shift report** (F7).

### Rules
- A shift can't be closed twice.
- Open orders/holds must be resolved (settled or voided) before close (config).
- Variance is computed **on-device** at close (offline-capable), re-verified server-side on sync.

---

## 8. F5 — Blind close & manager approval

**Blind close (recommended default):** the cashier counts the drawer **without seeing the expected
figure** — removes the temptation to "make it match." Expected + variance are revealed only after
they submit the count. Single highest-value cash-control feature.

**Manager variance approval:** if `|variance| > store.variance_threshold` (e.g. ₹50 short), the close
requires a manager to review/approve (or the session is flagged for review). Repeated shortages by a
cashier are surfaced (Phase 3 analytics / fraud flag).

Per-store config: `blind_close (on/off)`, `variance_threshold`, `require_manager_approval (on/off)`.

---

## 9. F6 — Force-close & handover

**Force-close** — a manager closes a session a cashier left open (went home, forgot):
- `status='force_closed'`, counted by the manager, `closed_by=manager`, variance attributed.
- Optional **auto-close cron** at end-of-day for sessions still open past store hours → flag.

**Handover** — cashier B takes over from A mid-day. Two patterns:
1. **Clean (recommended):** A **closes** (count + variance) → B **opens** (new float). Full
   accountability per person.
2. **Lightweight handover record:** carry the float forward to B without a full count (faster, less
   accountability) — Phase 2, config.

---

## 10. F7 — Reports (shift / X / Z)

| Report | When | Resets? | Contents |
|---|---|---|---|
| **Shift report** | at close (per session) | — | sales by tender, refunds, discounts, voids, # txns, opening float, expected vs counted, **variance**, cash movements, by cashier |
| **X-report** | mid-shift "read" | no | current totals without closing (a snapshot) |
| **Z-report** | end-of-day close | yes | official daily total across the day's sessions; the figure that goes to the books |

Reports are **read-only** and printable/shareable. A **variance log** lists every session's over/short
for owner review.

---

## 11. States & transitions (lock · count · pause)

A two-state `open|closed` model is too coarse for cash integrity: it lets a sale land **while the drawer
is being counted**, which changes expected cash mid-count and corrupts the variance. The real machine
locks selling during the count and supports breaks:

```
(no session)
     │ open (float)
     ▼
   OPEN ───────────── pause ──────────────► PAUSED ── resume ──► OPEN        (F8, §11C)
     │  ▲ sales allowed                         (no sales; attendance paused)
     │  │ resume
     │ begin close
     ▼
  LOCKING ──► COUNTING ──► CLOSING ──► CLOSED            (counted by cashier; immutable + frozen snapshot §15D)
   (sales      (drawer      (variance
    blocked)    count)       reveal/confirm)
     │
     └────────── force_close (manager) ──────► FORCE_CLOSED   (manager counts; flagged)
```

| State | Sales? | Meaning |
|---|---|---|
| `OPEN` | ✅ | normal operation; one `OPEN` per register |
| `PAUSED` | ❌ | cashier on break (lunch/prayer); attendance clock paused; drawer untouched |
| `LOCKING` | ❌ | close initiated — **selling disabled** so expected cash can't move under the count |
| `COUNTING` | ❌ | drawer being counted (denominations) |
| `CLOSING` | ❌ | expected/variance revealed (blind close), awaiting confirm / manager approval |
| `CLOSED` | ❌ | counted by cashier; **immutable**; financial snapshot frozen (§15D) |
| `FORCE_CLOSED` | ❌ | counted by a manager; flagged; snapshot frozen |

- **The LOCKING→COUNTING→CLOSING sub-flow is the cash-integrity core:** once a cashier taps "Close", no new
  sale can change the drawer. A queued offline sale stamped *before* `LOCKING` still applies (point-in-time,
  [sync §12](./sync-engine.md)); one stamped after is rejected `SHIFT_NOT_OPEN`.
- Every transition is an **immutable `shift_event`** (§15C), so the whole lifecycle is auditable and
  rebuildable.

---

## 11C. F8 — Shift pause / resume

Cashiers step away — lunch, prayer, a delivery. A pause is **not** a close (no count, drawer stays
assigned) but **does** stop selling and the attendance clock.

- `OPEN → PAUSED` records a `SHIFT_PAUSED` event (`reason`: break/prayer/lunch/other); POS shows a
  "Shift paused — resume to sell" lock screen.
- `PAUSED → RESUMED` records `SHIFT_RESUMED`; selling re-enabled.
- **Attendance** counts `worked = (closed_at − opened_at) − Σ paused_intervals` → accurate hours, not
  inflated by breaks (§15B reconciliation).
- **Offline:** pause/resume are local events, queued like any other; no network needed.
- A shift may not be **closed** directly from `PAUSED` without resuming (so the count happens against a
  live drawer) — or resume is implied by entering `LOCKING`; pick one and keep it consistent (recommend:
  auto-`RESUMED` event emitted when close begins).

---

## 12. Enforce open-shift-before-sale

Per-store config `enforce_open_shift_before_sale (on/off)`:
- **On:** a sale with no open session is blocked locally ("Open a shift first") and rejected at sync
  (`SHIFT_NOT_OPEN`).
- **Off:** sales allowed without a session (`shift_session_fk` nullable) — some kiranas don't want the ceremony.

When on, the order mutation must validate an open session for the register/store at apply time.

---

## 13. Multi-register & one-open-per-register

- **Invariant:** at most **one open session per register**.
- Multiple registers → multiple concurrent open sessions (one each).
- **Two devices on the same register:** bind a register to one device at a time, **or** scope the
  session to `(register, device)`. Most kirana = one device per counter, so per-register holds; design
  the constraint as `unique(register, status='open')`.

---

## 14. Offline-first behaviour

The shift session is the **spine of POS — it must work fully offline.**

| Action | Offline behaviour |
|---|---|
| Open shift | created locally; queued to sync; POS unlocks immediately |
| Sales / cash movements | all offline; link to the local session |
| Close shift | counted + variance computed **on-device** from local data; queued |
| One-open-per-register | enforced **locally** (per device/register); reconciled on sync (don't require an online lock) |
| Sync | session + movements + denomination counts pushed via the mutation pipeline; server re-verifies variance |
| Subscription lapse mid-shift | sales gated by the §30 write-gate (sales stamped before `access_valid_until` accepted) — see device-management §30 |

**Rule:** never require network to open a shift or ring a sale. Server is the reconciler, not the gate.

**Queue priority:** sales/payments/refunds are **HIGH priority** in the mutation queue — on a poor
connection they sync **before** inventory/audit/analytics (revenue never starves), while still
respecting FK order (`order` before `order_item`). See
[mobile-04 §8C.2a](./mobile-04-storage-and-state.md) (priority tiers + backoff + dead-letter).

---

## 14B. Device crash recovery

A POS device dies mid-shift (battery, OS kill, app crash). On relaunch the cashier must come back to a
**fully recovered shift**, not a blank drawer — because money has changed hands.

Everything that matters is **durably written to SQLite before it's acknowledged** (the event timeline
§15C, sales, cash movements, the in-progress count are all committed locally as they happen —
[mobile-09 INV-9/INV-10](./mobile-09-client-services-and-invariants.md)). So recovery is a **read**, not a
reconstruction:

| On relaunch, recover | From |
|---|---|
| The open shift (register, float, opened_at) | local `shift_session` (status `OPEN`/`PAUSED`/`LOCKING`/`COUNTING`) |
| Every sale + cash movement since open | local rows + `shift_event` timeline |
| An **in-progress drawer count** (counted-so-far) | a persisted **draft count** (denominations saved as entered, not only on submit) |
| Pending pushes | the mutation queue (resumes push-before-pull) |

- **Resume to the exact state:** if it crashed in `COUNTING`, reopen the count screen with the draft;
  if `OPEN`, resume selling. No double-open (the unique `OPEN` per register still holds).
- **The drawer count must be a saved draft**, written as each denomination is entered — never held only
  in component state — or a crash mid-count loses the count.
- Server reconciliation (§15G) catches any genuinely-lost tail on next sync.

---

## 15. Link to rota & attendance

- The **rota** ([rota-and-invitations.md](./rota-and-invitations.md) F7) schedules *who should work*;
  the **shift session** is what they *actually* opened.
- Optionally set `shift_session.rota_entry_fk` to the assignment being fulfilled (labour/attendance).
- **Clock-in/out** can simply *be* open/close shift (simplest for a kirana), or a separate punch
  (Phase 3). Opening the shift = clocking in is the recommended default.

---

## 15B. Scheduled vs actual — open freely, reconcile in reports

**The single most important rule in shift design.** "Opening a shift" = opening a **cash drawer on a
register** — it is **not** "clocking into the Morning shift template". So:

- The **rota / assignment** (e.g. "Morning 9–2") is a **plan**.
- The **shift session** (opening the drawer) is **reality** — it records the **actual** open time.
- **Opening a session is NEVER blocked by, or validated against, the assigned shift.** A member opens
  whatever register is free, whenever they actually arrive, regardless of what they were scheduled for.

> If "open shift" ever required the assigned time window, a person assigned Morning could not start
> work in the afternoon — broken. In retail, reality **always** diverges from the plan (late arrivals,
> swaps, covers, no-shows, doubles). **Open freely; reconcile in reports.**

### 15B.1 Worked example — assigned Morning, came afternoon
```
Member assigned "Morning (9–2)" arrives at 2:15pm
  → POS → "Open Shift" → pick register → enter float → (optional) tag "Afternoon/Unscheduled" → OPEN
  → session: opened_by=him, opened_at=2:15pm, register=R1   (NO "morning" check anywhere)
  → POS unlocks, he sells. Done.
Owner later sees in the attendance/variance report (NOT an error):
  "Scheduled Morning 9–2 · actually opened 2:15pm"  → late / shift-swap flag for review.
```

### 15B.2 Real-time scenarios (scheduled ≠ actual, and session edge cases)
| Scenario | How "open shift" behaves | What the owner sees (report) |
|---|---|---|
| **Assigned Morning, came afternoon** | opens freely at actual time | late / mismatch flag |
| Came **early** (7am for a 9am shift) | opens freely; no time-gate | "opened before scheduled start" |
| Came **late** | opens at actual time | lateness metric |
| **Not scheduled today, came in** (cover) | opens freely as **Unscheduled** | unplanned-session flag |
| **Scheduled but didn't show** (no-show) | *no* session exists for that rota entry | **no-show** flag |
| **Swap** — A scheduled, B came instead | **B** opens (`opened_by=B`) | "B covered A's slot" |
| **Mid-shift handover** (A leaves, B takes over) | A **closes** (count+variance) → B **opens** fresh | two sessions, clean per-person cash (F6) |
| **Double / stays past shift** | one continuous session (length ≠ scheduled window) | actual hours > scheduled |
| **Split shift** (morning + evening) | close after morning → **open again** evening | two sessions in one day |
| **Opens on the wrong register** | fine — session is per-register | which register is recorded |
| **Two people, one register** | one open session per register; 2nd person works it after handover, a 2nd register, or assists without opening | — |
| **Forgot to open, started selling** | enforce-shift **off** → null session · **on** → blocked "Open a shift first" | config-dependent (§12) |
| **Came before the shift window starts** | opens anyway; no time-gate | "early open" |
| **Manager opens / force-closes on behalf** | manager can open or force-close (gated) | force-close flagged (F6) |

### 15B.3 The two rules
- ✅ **Enforce:** one **open session per register** at a time (cash accountability, §13).
- ❌ **Never enforce:** that the session matches the person's *scheduled* shift time. The assignment
  drives **planning + attendance/variance reporting** (flags), **never** a block on opening the drawer.

### 15B.4 What the report reconciles (planned vs actual)
The attendance/variance view compares the **rota** (planned: who/when/where) against **shift sessions +
cash** (actual: opened_by, opened_at, closed_at, hours, variance). Outputs: late/early opens, no-shows,
covers/swaps, unscheduled sessions, hours worked vs scheduled, and cash variance per person — all as
**review flags**, not blocks.

---

## 15C. shift_event — the immutable timeline (event-sourced)

**The shift is event-sourced, exactly like stock ([sync §14](./sync-engine.md)).** `shift_session` holds
the *current* state; **`shift_event` is the append-only, immutable log of everything that happened.** This
is the same additive philosophy the architecture already adopted for POS writes ([sync §13](./sync-engine.md)) —
financial truth must never live only in a mutable row that can be overwritten.

```
shift_event { id, guuid, shift_session_fk, store_fk,
              event_type, created_by_user_fk, device_fk,
              seq,                  // monotonic per session (ordering, gap-detection)
              payload (jsonb),      // type-specific (amount, reason, denominations, variance…)
              created_at }          // append-only — never updated, never deleted
```

**Event types:**
`SHIFT_OPENED` · `PAY_IN` · `SALE` · `REFUND` · `PAY_OUT` · `DROP` · `TIP` · `SHIFT_PAUSED` ·
`SHIFT_RESUMED` · `COUNT_STARTED` · `COUNT_COMPLETED` · `VARIANCE_APPROVED` · `SHIFT_CLOSED` ·
`FORCE_CLOSED` · `DEPOSIT_TO_SAFE` · `MANAGER_OVERRIDE`.

- **Reports rebuild the entire timeline** from events — who did what, when, on which device. Drawer-
  ownership history ("who held R1 at 10 AM yesterday?") falls out for free.
- **Append-only + idempotent:** each event has a client `guuid`; redelivery is a no-op. Events are
  **HIGH-priority** sync mutations (same pipeline as sales).
- **`seq` per session** gives strict in-session ordering and lets the server detect a missing event
  (gap) during reconciliation (§15G).
- The mutable `shift_session` fields (`status`, `counted_cash`, `variance`) are a **projection** of the
  events — recomputable, never the sole source of truth.

---

## 15D. Immutable financial snapshot at close

At `CLOSED`/`FORCE_CLOSED`, the system **freezes a financial snapshot** — a self-contained JSON record of
the shift's money — and stores it on the session. **Reports of a closed shift read the snapshot; they
never recompute from mutable rows** (which could drift if a late sale syncs or a product price changes).

```
shift_session.closing_snapshot (jsonb, immutable once written) = {
  opening_float_paise, cash_sales_paise, card_sales_paise, other_tenders_paise,
  refunds_paise, pay_ins_paise, pay_outs_paise, drops_paise, tips_paise,
  expected_cash_paise, counted_cash_paise, variance_paise,
  txn_count, opened_at, closed_at, opened_by, closed_by,
  event_seq_high,                 // last shift_event.seq folded in — proves completeness
  computed_at, computed_on_device }
```

- **Written in the same local tx as the `SHIFT_CLOSED` event** ([mobile-09 INV-10](./mobile-09-client-services-and-invariants.md))
  — close and snapshot commit atomically.
- A sale that syncs **after** close (was queued offline, stamped before `LOCKING`) lands as an
  **adjustment** flagged on the report — it does **not** silently rewrite the frozen snapshot. The server
  reconciliation (§15G) surfaces the delta.
- This is what makes historical Z-reports **stable and audit-grade**.

---

## 15E. Audit log (financial config & overrides)

Financial **configuration changes and privileged overrides** must never rely on a mutable settings row —
they get their own immutable trail (broader than `shift_event`, which is per-session).

```
audit_log { id, guuid, store_fk, entity, entity_id, action,
            old_value (jsonb), new_value (jsonb),
            performed_by_user_fk, device_fk, ip?, created_at }   // append-only
```
Examples: manager changed `variance_threshold` 50→500; manager **reopened** a shift; blind-close toggled;
manager approved a high variance; float corrected. Each is one immutable row (old→new, who, device, when).
- Distinct from `shift_event` (session lifecycle) — `audit_log` is **store-level governance**.
- Same append-only, idempotent, HIGH-priority sync treatment.

---

## 15F. Safe & deposit management (cash chain)

A **drop** moves cash out of the drawer — but the money has to *go somewhere*. The full chain is tracked
so the store can reconcile end-to-end, not just per-drawer:

```
Drawer ──drop──▶ Safe ──deposit──▶ Bank deposit ──settle──▶ Bank account
```
- Extends `store_cash_ledger` (already Phase-2) with a `location` (`drawer`/`safe`/`in_transit`/`bank`)
  and event types `DROP` (drawer→safe), `DEPOSIT` (safe→bank), `ADJUSTMENT`.
- **Three balances** reconcile independently: **drawer balance** (per open session), **safe balance**
  (store), **deposit/in-transit balance** (until the bank confirms).
- A `DEPOSIT_TO_SAFE` `shift_event` links the drawer drop to the safe credit, so a drop can never
  "disappear" between drawer and safe.
- Phase 2+; the F3 `drop` already feeds the ledger today — this formalizes the downstream hops.

---

## 15G. Server reconciliation / integrity job

The client computes variance on-device (offline-first); the **server independently re-verifies** on a
schedule and on every shift close — defense against tampering, lost events, and client bugs.

```
for each closed shift_session:
  expected = opening_float + Σ(cash_sales) − Σ(refunds) + Σ(pay_in) − Σ(pay_out) − Σ(drops)
           (recomputed from shift_event, NOT from the client-sent expected_cash)
  if recomputed_expected ≠ snapshot.expected_cash_paise   → INTEGRITY_ALERT (tampering / lost event)
  if shift_event.seq has a gap                            → MISSING_EVENT alert
  if |variance| > threshold and not VARIANCE_APPROVED     → flag for manager
```
- Emits an **integrity alert** to the owner (not a silent log) — mirrors the stock oversell-reconciliation
  job ([sync §14](./sync-engine.md)) and its "surface it actionably" rule.
- Runs nightly + on close; idempotent; never mutates the frozen snapshot (only annotates with
  server-verified deltas).

---

## 15H. Shift notes

Free-text notes attached to a session for the things numbers don't capture — handover context, incidents.

- **Opening note** (e.g. "starting float short ₹200, owner aware"), **closing note** ("drawer key broken,
  counted in back office"), **manager note** (on approval/force-close).
- Stored on `shift_session` (`opening_note`, `closing_note`) + manager note on the approval event; shown
  on the shift report. Plain, optional, synced with the session.

---

## 16. Data model (greenfield)

All are **sync entities** (offline-first), pushed via the mutation pipeline.

```
register            { id, store_fk, name, is_active, carry_forward_float_paise? }

shift_session       { id, guuid, store_fk, register_fk, device_fk,
                      opened_by_user_fk, opened_at, opening_float_paise,
                      closed_by_user_fk, closed_at, counted_cash_paise,
                      expected_cash_paise, variance_paise,
                      status (open|paused|locking|counting|closing|closed|force_closed),   // §11
                      paused_total_ms,                       // Σ pause intervals → accurate worked hours (§11C)
                      closing_snapshot (jsonb)?,             // immutable financial freeze at close (§15D)
                      opening_note?, closing_note?,          // §15H
                      rota_entry_fk?, approved_by_user_fk?,
                      row_version, created_at, modified_at }
   // constraint: unique (register_fk) WHERE status IN ('open','paused','locking','counting','closing')

shift_event         { id, guuid, shift_session_fk, store_fk,              // §15C — append-only timeline
                      event_type, seq, payload (jsonb),
                      created_by_user_fk, device_fk, created_at }
   // append-only: never UPDATE/DELETE; unique (shift_session_fk, seq)

cash_movement       { id, guuid, shift_session_fk, store_fk,
                      type (pay_in|pay_out|drop|tip),
                      amount_paise, reason, by_user_fk, created_at }

denomination_count  { id, guuid, shift_session_fk, phase (opening|closing),
                      denomination_paise, count, is_draft }  // is_draft persisted as entered → crash recovery (§14B)

audit_log           { id, guuid, store_fk, entity, entity_id, action,    // §15E — financial governance
                      old_value (jsonb), new_value (jsonb),
                      performed_by_user_fk, device_fk, ip?, created_at }
   // append-only

store_cash_ledger   { id, store_fk, source (drop|deposit|adjustment),
                      location (drawer|safe|in_transit|bank),            // §15F cash chain
                      amount_paise, ref_shift_session_fk?, created_at }   // Phase 2

order               { …, shift_session_fk }                  // sales link here
```

---

## 17. Screens

| Screen | Purpose |
|---|---|
| Open Shift | pick register + enter opening float (amount or denominations) |
| POS (shift active) | sell; header shows shift status + (non-blind) expected cash + txn count |
| Cash Movement sheet | pay-in / pay-out / drop / tip + reason |
| Close Shift | count drawer (blind) → reveal expected/variance → confirm |
| Manager Approval | review high-variance close → approve / flag |
| Shift Report | per-session summary (printable/shareable) |
| X / Z Report | mid-shift read / end-of-day close |
| Variance Log | list of over/short per session (owner) |
| Registers | manage registers (Phase 2 for multi) |
| Shift settings | enforce-open-shift, blind-close, variance threshold, approval |

---

## 17B. Loading states (per flow)

Treatments use the [mobile-08 §13](./mobile-08-loading-ux-states.md) vocabulary — **A** native splash,
**B** full-screen blocking, **C** skeleton, **D** ambient/non-blocking, **E** optimistic. Rules live
in mobile-08; this maps each shift flow to a treatment.

| Flow | Treatment | Notes |
|---|---|---|
| Open shift (F1) | **E** | submit float → POS unlocks **immediately** (optimistic); no full-screen |
| First-ever register setup | **C** | brief shell skeleton while the default register provisions |
| Operate / POS (F2) | **D** | ambient sync chip (Syncing/Synced + pending count); never block |
| Cash movement (F3) | **E** + toast | instant local apply; reason sheet is a quick form |
| Close shift (F4) | **E + explicit confirm** | financial action — count, then confirm; reveal variance after submit |
| Blind close (F5) | **E + confirm** | expected/variance hidden until submit (the confirm is the reveal) |
| Manager variance approval (F5) | **modal** (not a loader) | review screen → approve/flag |
| Force-close (F6) | **E + confirm** | manager counts → confirm |
| Shift / X / Z report (F7) | **C** | section skeleton if computing/loading; instant if local |
| Sale blocked, no open shift (§12) | **banner/modal** | "Open a shift first" — not a loader |
| Offline open/close/sell | **D** | everything optimistic + ambient sync; never a network gate (§14) |

---

## 18. RBAC matrix

| Action | Owner | Manager | Cashier |
|---|---|---|---|
| Open / close own shift | ✓ | ✓ | ✓ (`Shift:create`) |
| Cash movement (normal) | ✓ | ✓ | ✓ (`CashMovement:create`) |
| Large cash movement | ✓ | ✓ | gated (`CashMovement:LARGE_AMOUNT`) |
| Force-close another's shift | ✓ | ✓ (`Shift:CLOSE_OTHER`) | ✗ |
| Approve high variance | ✓ | ✓ | ✗ |
| Reopen a closed shift | ✓ | gated (`Shift:REOPEN`) | ✗ |
| Manage registers / shift settings | ✓ | if granted | ✗ |
| View reports (X/Z/variance) | ✓ | if granted | own shift report only |

(Permissions are role-based — see RBAC in the rota PRD.)

---

## 19. Business rules

| ID | Rule |
|---|---|
| BR-SHF-001 | At most **one open `shift_session` per register** (`unique(register) WHERE status='open'`). |
| BR-SHF-002 | Opening float is the accountability baseline; recorded at open. |
| BR-SHF-003 | `expected = opening_float + cash_sales − cash_refunds + pay_ins − pay_outs − drops`. |
| BR-SHF-004 | `variance = counted_cash − expected_cash`; computed on-device, re-verified on sync. |
| BR-SHF-005 | **Blind close** default-on: expected hidden until the count is submitted. |
| BR-SHF-006 | `|variance| > threshold` → manager approval / flag (config). |
| BR-SHF-007 | Pay-out / drop require a **reason**; large amounts gated. |
| BR-SHF-008 | A closed/force-closed session is immutable (reopen is a separate gated action). |
| BR-SHF-009 | `enforce_open_shift_before_sale` (per-store) blocks sales with no open session (`SHIFT_NOT_OPEN`). |
| BR-SHF-010 | Shift session + movements + counts are **offline-first** sync entities. |
| BR-SHF-011 | Force-close attributes the count/variance to the manager; flagged. |
| BR-SHF-012 | Sales link to the session via `order.shift_session_fk` (NOT NULL when enforcement is on). |
| BR-SHF-013 | Cash drops feed the store cash ledger (Phase 2). |
| BR-SHF-014 | **Opening a session is NEVER gated by the scheduled/assigned shift** — any authorized member opens any free register at the actual time (§15B). |
| BR-SHF-015 | `session.opened_at` records the **actual** time; `rota_entry_fk` (optional) is just the assignment it fulfills. |
| BR-SHF-016 | Scheduled-vs-actual mismatches (late, early, no-show, swap, cover, unscheduled) are **report flags**, never blocks. |
| BR-SHF-017 | **Selling is disabled in `LOCKING/COUNTING/CLOSING/PAUSED`** — a close-in-progress or break can't have its drawer changed under it (§11). |
| BR-SHF-018 | Every lifecycle action is an **append-only `shift_event`** (§15C); `shift_session` mutable fields are a recomputable projection, never the sole truth. |
| BR-SHF-019 | Close **freezes an immutable `closing_snapshot`** (§15D) in the same tx as `SHIFT_CLOSED`; reports of closed shifts read the snapshot, never recompute. A late-syncing sale is an **adjustment**, never a rewrite. |
| BR-SHF-020 | Financial **config changes & overrides** are recorded in the append-only `audit_log` (old→new, who, device) (§15E). |
| BR-SHF-021 | Worked hours = `(closed_at − opened_at) − paused_total_ms` (§11C). |
| BR-SHF-022 | The drawer **count is persisted as a draft as entered** (`is_draft`) so a crash mid-count never loses it (§14B). |
| BR-SHF-023 | The server **independently re-verifies** every close from `shift_event` and raises an **integrity alert** on mismatch or event-gap (§15G) — never a silent log. |
| BR-SHF-024 | Cash chain `drawer→safe→deposit→bank` tracked via `store_cash_ledger.location` + `DEPOSIT_TO_SAFE` events; three balances reconcile independently (§15F). |
| BR-SHF-025 | **Till float policy is per-store config:** `carry_forward` (next shift opens with last close's counted cash) **vs** `fixed_float` (deposit all; next shift starts at a fixed float). |

---

## 20. Validation matrix

| Trigger | Check | Result |
|---|---|---|
| Open a register that's already open | `unique(register) WHERE open` | `SHIFT_ALREADY_OPEN` → resume / force-close |
| Open outside the scheduled shift window (early/late/wrong shift) | **no check** | **allowed** — opens at actual time (§15B) |
| Open when not scheduled today | **no check** | **allowed** — tagged Unscheduled (§15B) |
| Sale with no open shift (enforce on) | open session exists? | block locally; `SHIFT_NOT_OPEN` at sync |
| Close with unsettled holds (config) | open orders? | block until settled/voided |
| Close twice | status≠open | reject |
| High variance close | `|variance| > threshold` | require manager approval / flag |
| Pay-out without reason | reason present? | reject |
| Force-close by non-manager | `Shift:CLOSE_OTHER` | denied |
| Two devices open same register offline | local lock + sync reconcile | second open rejected on sync (conflict) |

---

## 21. Real-world scenarios

**S1 — Normal day.** Cashier opens with ₹2,000 float → rings 80 sales (cash + UPI) → one ₹300
petty-cash pay-out for a delivery → end of day blind-closes: counts ₹14,700; expected ₹14,720;
variance −₹20 (within threshold) → closed; Z-report printed.

**S2 — Short drawer.** Close variance −₹450 (> ₹50 threshold) → manager approval screen → manager
reviews movements, approves with a note → session flagged in the variance log.

**S3 — Left open overnight.** Cashier forgot to close. Next morning the manager **force-closes**
yesterday's session (counts the drawer), then the new cashier opens a fresh shift.

**S4 — Handover.** Morning cashier closes at 2pm (count + variance); afternoon cashier opens a new
shift with a fresh float → clean per-person accountability.

**S5 — Offline.** No network all afternoon: shift opened, 60 sales rung, two pay-ins, blind-close all
done offline; on reconnect everything syncs and the server re-verifies the variance.

**S6 — Multi-register.** Two counters: Register 1 (Priya) and Register 2 (Kumar) each have their own
open session and close independently; the Z-report sums both.

**S7 — Break mid-shift.** Priya goes to lunch → taps **Pause** (drawer untouched, POS locked) → returns
40 min later → **Resume**. Worked hours exclude the 40 min; two `SHIFT_PAUSED`/`SHIFT_RESUMED` events on
the timeline (§11C).

**S8 — Sale lands during the count.** Kumar starts closing (`LOCKING` → selling disabled). A customer
insists on one more item → he must **resume/abort the close** to sell, then re-count — the drawer can't
change under an in-progress count (§11). An offline sale queued *before* he tapped Close still applies and
shows as an adjustment (§15D).

**S9 — Device dies mid-shift.** Battery dies with 45 sales rung and a half-done count. On relaunch the
shift, all sales/movements, and the **draft count** are recovered from SQLite; Kumar resumes the count
where he left off (§14B).

**S10 — Tampering caught.** A modified client under-reports expected cash. The server reconciliation
recomputes expected from `shift_event`, finds the mismatch, and raises an **integrity alert** to the owner
(§15G).

**S11 — Drop to safe to bank.** ₹20,000 dropped to the safe (drawer→safe), evening deposit of ₹50,000
safe→bank; the three balances (drawer, safe, in-transit) reconcile; nothing "disappears" between hops
(§15F).

---

## 22. Feature list by phase

**Phase 1 (MVP):**
- Default register per store
- Open shift with single opening-float amount
- Sales link to session; **enforce-open-shift** (config)
- Cash movements: pay-in / pay-out (with reason)
- Close shift: single-amount count → expected, variance, close
- Basic shift report (sales by tender + variance)
- One-open-per-register; fully **offline-first**

**Phase 2 (cash-control grade):**
- Denomination counting (notes/coins) + **draft count** (crash recovery, §14B)
- **Blind close** + manager variance-approval threshold
- **`shift_event` immutable timeline** (§15C) + **immutable close snapshot** (§15D)
- **Lock/COUNTING states** + **pause/resume** (§11, §11C)
- **`audit_log`** for config/overrides (§15E)
- **Server reconciliation / integrity job** (§15G)
- Cash **drops to safe** + store cash ledger
- Shift **notes** (§15H)
- **X / Z reports** (read from the frozen snapshot)
- **Force-close** + **handover**
- Multi-register
- Carry-forward float vs fixed-float (till policy config, BR-SHF-025)

**Phase 3 (workforce + analytics):**
- Clock-in/out + timesheets (tie to rota)
- Labour cost on shift/rota
- Variance analytics + per-cashier fraud flags
- **Safe & deposit management** + bank-deposit reconciliation (§15F)

---

## 23. Key design decisions

| # | Decision |
|---|---|
| D1 | The shift session **opens/closes/sells fully offline** — never gate the spine of POS on network. |
| D2 | **One open session per register**, enforced **locally** + reconciled on sync (no global online lock). |
| D3 | **Variance computed on-device** at close; server re-verifies on sync. |
| D4 | **Blind close** is the default — the highest-value cash-control/anti-fraud feature. |
| D5 | `enforce_open_shift_before_sale` is **per-store config** (not everyone wants the ceremony). |
| D6 | `shift` (template), `shift_assignment` (standing), `shift_session` (cash) are **distinct** — never conflate. |
| D7 | **Open shift = clock-in** by default (simplest attendance for a kirana); separate punch is Phase 3. |
| D8 | All shift/cash entities are **sync mutation entities** (push via `/sync/delta`) — see backend plan WS-A. |
| D9 | **The shift is event-sourced** (`shift_event`, §15C) — same additive philosophy as stock ([sync §13/§14](./sync-engine.md)); the mutable session row is a projection, financial truth is the append-only log. |
| D10 | **Close freezes an immutable financial snapshot** (§15D) — historical reports are audit-grade and never drift; late writes are adjustments, not rewrites. |
| D11 | **Selling locks during count/close and pauses** (§11) — cash integrity beats the convenience of one-more-sale-mid-count. |
| D12 | **Server independently re-verifies** money from the event log and **alerts** (§15G) — the client is offline-authoritative but not trusted as final. |

---

## 24. Backend changes required

These are POS **write** entities — they need mutation handlers (today none exist for shift/cash;
see [backend-implementation-plan.md WS-A](./backend-implementation-plan.md)).

| # | Change | Phase |
|---|---|---|
| 1 | `register` table + default-register provisioning on store create | 1 |
| 2 | `shift_session` table + `unique(register) WHERE status='open'` + **`shift_session` mutation handlers** (open/close/force-close) | 1 |
| 3 | `order.shift_session_fk` → NOT NULL when `enforce_open_shift_before_sale` is on; **open-shift check in the order handler** (resolves dead `SHIFT_NOT_OPEN`) | 1 |
| 4 | `cash_movement` table + mutation handlers (pay-in/out/drop/tip) | 1 |
| 5 | Per-store config: `enforce_open_shift_before_sale`, `blind_close`, `variance_threshold`, `require_manager_approval` | 1–2 |
| 6 | `denomination_count` table + handlers | 2 |
| 7 | `store_cash_ledger` + drop integration | 2 |
| 8 | Shift / X / Z report queries (read endpoints or computed locally) | 1–2 |
| 9 | Force-close + reopen flows (gated by `Shift:CLOSE_OTHER` / `Shift:REOPEN`) | 2 |
| 10 | Variance analytics + fraud flags | 3 |
| 11 | Add `RotaEntry`/`ServiceArea`/`ShiftSession`/`CashMovement` permission entities to the RBAC matrix | 1–2 |
| 12 | **`shift_event` table** (append-only, `unique(session, seq)`) + emit events from every shift/cash handler (§15C) | 2 |
| 13 | **`closing_snapshot`** frozen in the close handler (same tx as `SHIFT_CLOSED`); reports read it (§15D) | 2 |
| 14 | **Lock/COUNTING/CLOSING + PAUSED states** in `shift_session` + the order handler's open-shift check honours them (§11) | 2 |
| 15 | **`audit_log` table** + write on every financial-config/override change (§15E) | 2 |
| 16 | **Reconciliation/integrity job** — recompute expected from `shift_event`, alert on mismatch/gap (§15G); mirrors stock oversell job | 2 |
| 17 | `store_cash_ledger.location` + `DEPOSIT_TO_SAFE`/`DEPOSIT` events (safe/deposit chain, §15F) | 3 |
| 18 | Till-policy config `carry_forward` vs `fixed_float` (BR-SHF-025); `opening_note`/`closing_note`; `paused_total_ms` | 2 |
