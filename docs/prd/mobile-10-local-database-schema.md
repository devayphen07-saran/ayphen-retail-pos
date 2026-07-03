# Mobile Architecture · Part 10 — Local Database & Storage Tiering

> Part of the [Mobile Post-Login & Freshness](./MOBILE_POST_LOGIN_AND_FRESHNESS.md) series.
> **Question answered:** exactly which data lives in on-device **SQLite**, which lives in
> **SecureStore/MMKV**, and which must be a **direct API call** (never a local table) — reasoned from the
> backend sync registry + every offline scenario.
> **Companions:** the storage decision rule + mutation-queue shape in
> [mobile-04 §8C](./mobile-04-storage-and-state.md); the verified sync registry & writable set in
> [sync-engine §3](./sync-engine.md); the endpoint truth in [api-reference.md](./api-reference.md).
> **Legend:** ✅ synced today · 🆕 local table exists, server push handler is the #1 gap · ⛔ never a local table.

---

## Table of contents

1. [The decision framework](#1-the-decision-framework)
2. [A — Synced domain tables (SQLite, per `store_fk`)](#2-a--synced-domain-tables-sqlite-per-store_fk)
3. [B — Client-only bookkeeping tables](#3-b--client-only-bookkeeping-tables)
4. [C — Drafts & ephemeral client state](#4-c--drafts--ephemeral-client-state)
5. [D — API-only (never a local table)](#5-d--api-only-never-a-local-table)
6. [Gray-area calls & recommendations](#6-gray-area-calls--recommendations)
7. [Cross-cutting rules](#7-cross-cutting-rules-the-all-scenarios-parts)
8. [Canonical table list — the definitive set](#8-canonical-table-list--the-definitive-set)
9. [Reference-schema mapping (adopting an existing Drizzle schema)](#9-reference-schema-mapping-adopting-an-existing-drizzle-schema)

---

## 1. The decision framework

A thing earns a **local SQLite table** only if it passes the offline-first test:

1. **Needed at POS time without network?** (ring a sale, look up price/stock/customer, open/close a shift,
   take cash) → must be local.
2. **Written offline?** → local table **+** a `mutation_queue` row.
3. **Read-only reference needed offline?** → local, pull-only.

It must be **API-only (never a stale local copy)** if any of these holds:

4. **Authoritative / must never be stale** — subscription enforcement, device-limit, live RBAC truth.
5. **Sensitive credential** → SecureStore, never SQLite.
6. **Large, rarely read, or signed-expiring** — media URLs, deep history, invoices, plan catalog.
7. **Account-level + rarely viewed** — invitations, my-devices.

> **Backend reality** ([sync-engine §3](./sync-engine.md), [api-reference.md §5](./api-reference.md)):
> the server syncs ~21 entities; **only `product, product_case, customer, supplier, paymentaccount,
lookup` are writable** (have mutation handlers). The POS write entities (`order/shift/cash/stock`) are
> the **#1 gap** — build their local tables + queue now, but pushes return `UNKNOWN_MUTATION` until the
> handlers ship (WS-A). The queue simply holds them (with backoff), so local-first is safe to build ahead.

---

## 2. A — Synced domain tables (SQLite, per `store_fk`)

### A1. Reference / config — pull-only (read offline, can't edit offline)

| Table                 | Why local                                                                                        | Note                |
| --------------------- | ------------------------------------------------------------------------------------------------ | ------------------- |
| `store`               | active-store header; **fold `store_hours` + logo `attachment_id` onto it** → zero-network switch | small ✅            |
| `unit`                | UoM for display/printing on receipts                                                             | tiny ✅             |
| `taxrate`             | **must** compute sale totals offline                                                             | tiny ✅             |
| `payment_method`      | tender choices offline                                                                           | tiny ✅             |
| `lookup`              | category/enum lookups                                                                            | small ✅ (writable) |
| `staff`               | attribute sales/shifts to a cashier **name** offline + reports                                   | small ✅            |
| `store_device_access` | renders Manage-Devices list offline                                                              | pull-only ✅        |

### A2. Catalog / master — writable offline (have handlers today)

| Table                        | Why local                                                  |
| ---------------------------- | ---------------------------------------------------------- |
| `product` (+ `product_case`) | heart of POS — search, price, barcode, stock projection ✅ |
| `customer`                   | attach to sale, loyalty, credit, offline edits ✅          |
| `supplier`                   | purchase/stock references ✅                               |
| `paymentaccount`             | tender accounts ✅                                         |

> `product.stock_quantity` is a **projection** on the product row — recomputed from the stock ledger
> (§A4), never an independent source of truth.

### A3. Transactional / POS — writable offline (local tables ready; server handlers = the gap 🆕)

| Table                                  | Why local                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `order`, `order_item`, `order_payment` | rung-up sales persist offline + reports/reprint                                            |
| `register`                             | the unit a shift opens against                                                             |
| `shift_session`                        | open/operate/close fully offline (incl. `closing_snapshot`, `paused_total_ms`)             |
| `shift_event`                          | append-only shift timeline (event-sourced, [shifts §15C](./shifts-and-cash-management.md)) |
| `cash_movement`                        | pay-in/out/drop/tip offline                                                                |
| `denomination_count`                   | drawer counts (`is_draft` for crash recovery)                                              |
| `audit_log` (financial)                | config/override records **this device** creates → write-local + push (history via API, §7) |

### A4. Inventory / ledgers — read offline + writable (sales decrement, adjustments)

| Table                                                    | Why local                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `stock_event`                                            | append-only signed-delta ledger; authoritative stock = `SUM(delta)` |
| `stock_take` (+ `_line`), `stock_adjustment` (+ `_line`) | counts/adjustments offline                                          |
| `fifo_cost_layer`                                        | cost/margin offline                                                 |
| `stock_history`                                          | movement view (**retention-bounded**, §7)                           |

### A5. Scheduling — local _if_ offline viewing matters (recommend sync)

| Table                        | Why                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `rota_entry`, `service_area` | staff check "am I on today, which counter?" on-device → needs offline read; low volume. No server REST yet (schema-ready, sync-only). |

---

## 3. B — Client-only bookkeeping tables (NOT server tables)

| Table                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync_cursor`                                 | one delta cursor **per `store_fk`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `local_store_state`                           | **multi-store eviction + per-store hint:** `store_id`, `status` (`cached`/`evicted`), `last_used_at`, `last_synced_at` (the last-N cache policy, [mobile-06 §8.6](./mobile-06-multi-store-offline.md)) + the per-store subscription banner **hint** (`sub_status`, `sub_plan_code`, `sub_trial_ends_at`, `sub_checked_at` — §4)                                                                                                                                                                                              |
| `sync_init_progress`                          | cold-start phase per `(store, entity)` — resumable ([mobile-09 INV-9](./mobile-09-client-services-and-invariants.md))                                                                                                                                                                                                                                                                                                                                                                                                        |
| `mutation_queue` (a.k.a. `pending_mutations`) | outbound queue: `mutation_id (ULID)`, `entity_type`, `entity_guuid`, `action`, `payload`, `expected_row_version`, `client_modified_at`, `parent_guuid`, **`priority`**, `attempts`, `next_attempt_at`, `server_row`, `expires_at`, `dead_lettered_at`/`dead_letter_reason`, **`status`** ∈ `{pending, inflight, applied, rejected, conflict, dead}`, + diagnostics `first_failure_at`, `last_failure_at`, `error_code`, `error_message` ([mobile-04 §8C.2a](./mobile-04-storage-and-state.md), [sync §15](./sync-engine.md)) |
| `failed_applies` _(pull-side DLQ)_            | server rows that **couldn't apply locally** (missing FK, schema mismatch): `entity_type`, `entity_guuid`, `store_id`, `data`, `attempts`, `last_attempt_at`, `last_error`. Surface like the push DLQ.                                                                                                                                                                                                                                                                                                                        |
| `schema_meta`                                 | local schema version → **migrate-before-sync** ([mobile-09 INV-5](./mobile-09-client-services-and-invariants.md)) (Drizzle's `__drizzle_migrations` can serve this)                                                                                                                                                                                                                                                                                                                                                          |
| `sync_metrics` _(optional)_                   | queue depth / last push-pull / DLQ count for the debug screen + sync chip                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

> **Conflicts are tracked on the queue row**, not a separate table — a conflicted mutation stays in
> `mutation_queue` with `status='conflict'` + the captured `server_row`, so the resolver works offline.
> A dedicated `sync_conflict` table is **optional** (only if you want a conflict view decoupled from the
> queue). The server `GET /sync/conflicts` is the reconciliation source, not the live store.
> **Tombstones** can be applied directly (delete the local row on `deletes[]`); a small `tombstones`
> table `(entity_type, entity_guuid, deleted_at)` is **optional** and useful only to defeat a
> late-upsert-after-delete race — add local cleanup if you keep it.

---

## 4. C — Drafts & ephemeral client state

| Item                                                                                                                        | Where                                           | Why                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cart / held order                                                                                                           | **the `orders`/`order_items` open row**         | an in-progress sale **is** an `order` with `status='open'` — durable + crash-safe with no extra table. (No separate `cart_draft`; the active line items only live in memory until the first write, then become the open order.) |
| denomination draft                                                                                                          | **SQLite** (`is_draft` on `denomination_count`) | crash mid-count must not lose the count ([shifts §14B](./shifts-and-cash-management.md))                                                                                                                                        |
| **account** subscription write-gate guard (`access_valid_until`, `status`, `server_time_offset_ms`, `subscription_version`) | **SecureStore/MMKV** (rides the snapshot)       | the **authoritative** offline write-gate; **not** a sync table ([device §30.2](./device-management.md#30-offline-expiry-write-gating-handshake-resolves-d1))                                                                    |
| **per-store** subscription banner _hint_ (`sub_status`, `sub_plan_code`, `sub_trial_ends_at`, `sub_checked_at`)             | **SQLite** (on `local_store_state`, §3)         | drives the per-store banner only; **never** the write-gate (that's the SecureStore guard above)                                                                                                                                 |
| tokens + signed snapshot + sig                                                                                              | **SecureStore**                                 | credentials — never SQLite                                                                                                                                                                                                      |
| clock offset, UI prefs, last route                                                                                          | **MMKV/memory**                                 | device-local, non-sensitive                                                                                                                                                                                                     |

---

## 5. D — API-only (never a local table) ⛔

| Thing                                       | Endpoint                                                      | Why not local                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Subscription truth                          | `GET /me/subscription` (+`/sv`)                               | authoritative, changes without a `pv` bump → a stale copy would mis-gate writes; the snapshot carries only an optimistic **hint** |
| Invitations                                 | `GET /me/invitations`                                         | account-level, rare, must be fresh (deliberately out of bootstrap)                                                                |
| Device lists                                | `GET /stores/:id/devices`, `/devices/my`                      | must reflect live slots; rarely viewed                                                                                            |
| Plan catalog                                | `GET /subscription/plans`                                     | near-static, billing-screen only → 24h **memory** cache, not SQLite                                                               |
| Media / attachment URLs                     | attachment endpoints                                          | **signed + expiring** — store only the `attachment_id` on the synced row; fetch the URL lazily on render                          |
| RBAC roles / permission matrix (editing)    | `/stores/:id/rbac/*`                                          | owner config, online; effective perms for **gating** come from the snapshot (memory), not a table                                 |
| Ownership transfer                          | `/stores/:id/ownership-transfer/*`                            | rare, multi-step, online                                                                                                          |
| Store hours / config                        | `GET /stores/:id/context` (or fold hours onto synced `store`) | small; recommend folding onto `store` so a switch is zero-network                                                                 |
| Deep history / reports / analytics          | server read endpoints                                         | X/Z & shift reports are **derived** from local `order`/`shift_*` for the recent window; old history via API                       |
| General server audit (logins, role changes) | API                                                           | not needed offline, large — distinct from the **financial** `audit_log` (A3), which **is** synced                                 |

---

## 6. Gray-area calls & recommendations

| Candidate                                                                                                  | Call                                                                                                          | Rationale                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **store hours**                                                                                            | **fold onto synced `store`** (else `/context` on open)                                                        | small + store-scoped; folding gives the zero-network store switch and avoids a re-fetch on every switch                             |
| **rota_entry / service_area**                                                                              | **sync (local)**                                                                                              | staff must read their schedule offline; low volume. If editing is owner-only/online, still sync for read                            |
| **conflicts**                                                                                              | **on the `mutation_queue` row** (`status='conflict'` + `server_row`); separate `sync_conflict` table optional | conflicts come from your own queued mutations — resolve offline; `/sync/conflicts` is the reconciliation source, not the live store |
| **ledger history** (`stock_event`, `shift_event`, `stock_history`, financial `audit_log`, closed `order`s) | **rolling-window local + API for old**                                                                        | see §7 — unbounded local ledgers bloat the device                                                                                   |
| **plans**                                                                                                  | **24h memory cache**                                                                                          | static-ish, billing-only — not worth a sync table                                                                                   |

---

## 7. Cross-cutting rules (the "all scenarios" parts)

- **Ledgers need a retention window, not unbounded local storage.** `stock_event`, `shift_event`,
  `stock_history`, financial `audit_log`, and closed `order`s grow forever on a long-running kirana device.
  Keep **the open shift + its events + a rolling window** (e.g. last 30–90 days) locally; fetch older via
  API. Without this, SQLite bloats indefinitely.
- **Everything domain is partitioned by `store_fk`;** bookkeeping (`sync_cursor`, `sync_init_progress`) is
  keyed by store. **Eviction** of the (N+1)th cached store = drop its `store_fk` partitions + its cursor
  ([mobile-06 §8.6](./mobile-06-multi-store-offline.md)). Account-level state (subscription guard, plan
  cache) is **not** store-partitioned.
- **The snapshot is the one all-stores-in-one document** — it lives in **SecureStore** (hydrated to memory
  for gating), **never** split into per-store SQLite permission tables ([mobile-01 §2](./mobile-01-auth-and-snapshot.md)).
- **Migrate before sync** ([mobile-09 INV-5](./mobile-09-client-services-and-invariants.md)): `schema_meta`
  gates the first delta after an app update so new columns exist before rows land.
- **Cursor advances only after the rows commit** ([mobile-09 INV-9/INV-10](./mobile-09-client-services-and-invariants.md))
  — the bookkeeping tables and domain upserts commit in one tx.
- **Write-local-then-push is valid today for POS entities** — but pushes are rejected until the
  `order/shift/cash/stock` handlers ship; the queue holds them with backoff, so local tables can be built
  ahead of the backend.

---

## 8. Canonical table list — the definitive set

This is the authoritative list of **every local table the app should have, and nothing else.** `R` =
pull-only (read offline). `R/W` = written offline + pushed via `/sync/delta`. 🆕 = local table is correct
now but the **server push handler doesn't exist yet** (#1 gap) — the queue holds writes until WS-A ships.

### 8.1 SQLite — synced domain tables (one row-set per `store_fk`)

**Reference / config (R)**
| Table | Purpose |
|---|---|
| `store` | active-store header (fold hours + logo `attachment_id` here) |
| `unit` | units of measure |
| `taxrate` | tax rates — needed to total a sale offline |
| `payment_method` | tender types |
| `lookup` | categories / enums (R/W) |
| `staff` | cashier names for attribution + reports |
| `store_device_access` | Manage-Devices list, offline |
| `shift_definition` | named shift templates ("Morning 9–2") for rota display |

**Catalog / master (R/W)**
| Table | Purpose |
|---|---|
| `product` (+ `product_case`) | catalog; `stock_quantity` is a projection of the ledger |
| `customer` (+ `customer_contact`*) | buyers; `*contact`child only if multi-contact (B2B) |
|`supplier`(+`supplier_contact`*) | vendors; `\*contact`child only if multi-contact (B2B) |
|`paymentaccount` | bank / UPI / card / wallet tender accounts |

**POS / transactional (R/W) 🆕**
| Table | Purpose |
|---|---|
| `order`, `order_item`, `order_payment` | sales + line items + **tender split** (open order = the cart) |
| `register` | the drawer a shift opens against |
| `shift_session` | the cash session (open/operate/close/pause) |
| `shift_event` | append-only shift timeline (event-sourced) |
| `cash_movement` | pay-in / pay-out / drop / tip |
| `denomination_count` | drawer counts (`is_draft` = crash recovery) |
| `audit_log` (financial) | config-change / override trail this device creates |

**Inventory / ledgers (R/W) 🆕**
| Table | Purpose |
|---|---|
| `stock_event` | **authoritative** append-only signed-delta ledger (`SUM(delta)` = stock) |
| `stock_take` (+ `stock_take_line`) | physical counts |
| `stock_adjustment` (+ `stock_adjustment_line`) | manual adjustments |
| `fifo_cost_layer` | FIFO cost for offline COGS/margin |
| `stock_history` | movement view (retention-bounded, §7) |

**Scheduling (R/W, sync — for offline viewing)**
| Table | Purpose |
|---|---|
| `shift_assignment` | a member's standing shift |
| `rota_entry` | weekly roster row |
| `service_area` | store zone tagged on a rota entry |

### 8.2 SQLite — client-only bookkeeping (NOT server tables)

| Table                       | Purpose                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `sync_cursor`               | delta cursor per store                                                                        |
| `sync_init_progress`        | cold-start phase per `(store, entity)`                                                        |
| `local_store_state`         | last-N eviction (`status`, `last_used_at`) + per-store subscription **banner hint** (`sub_*`) |
| `mutation_queue`            | outbound queue (priority · backoff · DLQ · `status` · diagnostics · conflict-on-row)          |
| `failed_applies`            | pull-side DLQ (server rows that couldn't apply locally)                                       |
| `schema_meta`               | local schema version → migrate-before-sync (or Drizzle's migrations table)                    |
| `sync_metrics` _(optional)_ | queue depth / last sync / DLQ count for the sync chip                                         |

### 8.3 App-bundled static (shipped in the build, read locally)

| Table    | Purpose                                               |
| -------- | ----------------------------------------------------- |
| `states` | Indian GST states — never changes; bundle, don't sync |

### 8.4 NOT in SQLite — other storage

| Item                                                                                                                                               | Where             |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| tokens · signed snapshot + sig · **account** subscription write-gate guard (`access_valid_until`, `server_time_offset_ms`, `subscription_version`) | **SecureStore**   |
| clock offset · UI prefs · plan-catalog cache                                                                                                       | **MMKV / memory** |

### 8.5 NOT local at all — direct API only (⛔)

`GET /me/subscription` (truth) · `/me/invitations` · device lists · `/subscription/plans` · media/attachment
URLs · RBAC role/permission editing · ownership transfer · store hours/config (`/context`) · deep
history / reports / analytics · general server audit · `product_price_history` · `product_stock`
(only add locally if **multi-location**) · `retired_pos_codes` (server owns POS-code assignment).

> **No `cart_draft`, no `sync_conflict`, no `tombstones`, no `product_price_history`, no
> `retired_pos_codes`, no `product_stock`** (single-location): cart = the open `order`; conflicts ride the
> `mutation_queue` row; deletes apply directly; the rest are API-only or bundled. That is the complete set.

---

## 9. Reference-schema mapping (adopting an existing Drizzle schema)

A sibling project's mobile Drizzle schema was evaluated as a base. It's ~90% aligned with this doc; adopt
most of it with the fixes below.

### 9.1 Take as-is

- **Bookkeeping:** `pending_mutations` (= `mutation_queue`), `sync_state` (= `sync_init_progress`),
  `global_sync_cursor` (= `sync_cursor`), `local_store_state` (eviction + per-store hint), and
  **`failed_applies`** (pull-side DLQ — keep it, it's better than this doc originally specced).
- **Domain:** `stores`, `lookups`, `units`, `products`, `product_cases`, `customers`, `suppliers`,
  `staff`, `payment_methods`, `tax_rates`, `payment_accounts`, `orders`, `order_items`, `stock_events`,
  `stock_takes`(+lines), `stock_adjustments`(+lines), `stock_history`, `store_device_access`.
- **Patterns to keep:** the `order_items` paise↔text **CHECK constraints** (integrity); `stock_events`
  as the **event-sourced ledger** (§A4 / [sync §14](./sync-engine.md)); the open-status `orders` row as
  the durable **cart** (§4).

### 9.2 Take, but fix (conflicts with this doc)

| Fix                         | Problem                                                                                                                                  | Resolution                                                                                                                                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Queue priority**          | `pending_mutations` has no `priority` (drain orders by `created_at`) → a sale can sync behind audit/stock on a poor link                 | add `priority`; order the drain index by it (HIGH order/payment > MEDIUM stock/cash > LOW audit)                                                                                                                                                                                          |
| **Status enum**             | theirs = `{pending, sending, failed, conflict, dead}`, no `applied`                                                                      | standardize on `{pending, inflight, applied, rejected, conflict, dead}` (map `sending→inflight`, `failed→rejected`); keep `applied`                                                                                                                                                       |
| **Queue diagnostics**       | single `last_error`                                                                                                                      | add `first_failure_at`, `last_failure_at`, `error_code`, `error_message` (§3 / [sync §15](./sync-engine.md))                                                                                                                                                                              |
| **Subscription tiering**    | per-store sub state in SQLite _and_ used as the gate                                                                                     | the **account write-gate guard** (`access_valid_until`, `server_time_offset_ms`, `subscription_version`) lives in **SecureStore** (§4 / [device §30.2](./device-management.md#30-offline-expiry-write-gating-handshake-resolves-d1)); `local_store_state.sub_*` is a **banner hint only** |
| **Contacts dual-sync**      | `customer_contacts`/`supplier_contacts` carry a per-row `sync_status` — a 2nd sync mechanism, and the backend has **no contact handler** | route everything through the one `mutation_queue`; contacts ride **inside the customer/supplier mutation payload** (child rows), drop `sync_status`                                                                                                                                       |
| **Triple stock projection** | `product.stock_quantity` + `product_stock.quantity_on_hand` + `SUM(stock_events)`                                                        | `stock_events` is **authoritative**; the other two are projections recomputed from it ([sync §14](./sync-engine.md)) — one recompute path, don't let them diverge                                                                                                                         |
| **Money columns**           | `order_items` has paise↔text CHECKs but `products`/`orders`/`payment_accounts` don't                                                    | make **integer paise canonical**, derive display; or add the same CHECKs everywhere                                                                                                                                                                                                       |

### 9.3 Reconsider — make API-only / app-bundled / drop

| Their table                    | Verdict                              | Why                                                                                                                                |
| ------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `states`                       | **app-bundled** (static seed)        | GST states never change — ship in the build, don't sync/API                                                                        |
| `product_price_history`        | **API on demand**                    | history is a back-office view; current price is on `products`                                                                      |
| `retired_pos_codes`            | **drop**                             | let the server own POS-code assignment (it already avoids reuse); keep only if the client must finalize codes offline for receipts |
| `product_stock` (per-location) | **drop for single-location**         | redundant with `product.stock_quantity`; keep only if multi-location is real                                                       |
| `fifo_cost_layers`             | **keep only if offline margin/COGS** | else server-compute; it's in the sync set, so keeping is fine                                                                      |
| `tombstones`                   | **optional**                         | applying deletes directly is enough; keep only for the late-upsert race (+cleanup)                                                 |

### 9.4 Missing — add for our PRD scope

Their `shifts` is the **Phase-1 minimal** model. For the cash-control PRD ([shifts](./shifts-and-cash-management.md)) add:
`cash_movement`, `shift_event` (timeline), `register`, `denomination_count` (`is_draft`), `audit_log`
(financial), and **`order_payment`** (their `orders` has only `total_paise` — no tender split). Plus
`rota_entry`/`service_area` if offline scheduling is in scope. If staying Phase-1 (single tender, simple
open/close), their `shifts` is fine and you only need `order_payment`.

### 9.5 Correct API-only choices they already made (keep out of SQLite)

No local tables for subscription **truth**, invitations, my-devices list, plan catalog, or media URLs —
matches §5. (Only nuance: the `local_store_state.sub_*` cache is a hint, not the gate — §9.2.)
