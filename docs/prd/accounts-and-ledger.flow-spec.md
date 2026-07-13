# Accounts, Cash & Ledger — Flow Specification

> **Mode:** A (author). Companion to [`accounts-and-ledger.md`](./accounts-and-ledger.md) (the
> design + phase plan) — this file is the **buildable spec**: every entity/field, every validation
> with its exact message, every numbered business rule, every state machine (legal + illegal), the
> scenario catalogue walked, error handling, UX, and acceptance criteria.
> **Status:** greenfield. All money is **integer paise**. All writes are **offline-first**:
> created locally, queued, applied on sync, and judged by the actor's permissions **at the time of
> the action**, not at sync time.

---

## 1. Summary

**What it does.** Turns every money event in the POS (opening balance, sale, refund, manual cash
in/out, cash count, credit sale + settlement, vendor bill + payment, order) into an **append-only
event** that the server folds into three derived books — **Account** (cash/bank), **Customer**
(receivables), **Supplier** (payables) — so a cashier can open a payment account and see its cash
in/out, and the business can track who owes whom.

**Real requirement (beneath the ask).** Not "a ledger screen" — a **trustworthy, offline-capable
cash book** where the client can never invent money, two devices can sell at once without
corrupting balances, and every peso is traceable to the event that created it.

**Actors.** Cashier (sells, refunds, counts, adds cash), Store Owner/Manager (all of that +
large-amount cash, credit approval, order accept, vendor pay), Credit Customer (places orders),
the **Server** (sole authority for postings and balances), the **Sync engine** (transport).

**Trigger.** Any money event initiated on a device, or a store being created.

**Success.** The event is durably stored locally, queued, accepted by the server, folded into the
projections, and the same balance is visible on every device after sync.

**Failure.** The event is rejected (validation/permission) with a defined message and **no
side-effect**, or it is accepted-with-flag (offline limit breach) — never silently dropped, never a
torn posting.

**Constraints.** Offline-first (SQLite + mutation outbox), multi-tenant (store-scoped), multi-device
per store, money (paise, no floats), append-only (no optimistic-lock on transactional data), RBAC
(`Sale`/`Refund`/`Order`/`CashMovement`/`Shift` entities + special actions).

---

## 2. Key Decisions

D1–D11 are fixed in [`accounts-and-ledger.md` §0](./accounts-and-ledger.md); not repeated. The
spec-level decisions this document adds:

| # | Fork | Options | Decision | Why it beats the alternatives |
|---|------|---------|----------|-------------------------------|
| SD-1 | How a sale becomes cash on the books | (a) client posts `account_transaction`; (b) **server derives from the sale event in one tx** | **(b)** | (a) allows torn state + a lying client minting cash; (b) binds cash to its sale atomically and server-authoritatively. |
| SD-2 | Balance representation | (a) stored balance column; (b) **Σ over events + checkpoint** | **(b)** | (a) drifts and lost-updates under offline concurrency; (b) is rebuildable and conflict-free. Checkpoint caps the scan. |
| SD-3 | Sale lifecycle on device | (a) draft→complete two-step; (b) **atomic complete** | **(b)** for POS cash/card; draft only for parked carts | A tendered POS sale is one act; a draft state adds abandonment/stranding with no user value on the hot path. |
| SD-4 | Void vs delete a sale | (a) hard delete; (b) **void = reversing event** | **(b)** | Append-only: history is immutable; a void posts compensating rows, preserving audit. |
| SD-5 | Refund cap enforcement | (a) trust client; (b) **server caps at sale net of prior refunds** | **(b)** | Money integrity is server-authoritative; the client value is advisory. |
| SD-6 | Credit-limit breach offline | (a) block locally (impossible atomically); (b) **advisory local + accept-and-flag server** | **(b)** (= D6) | Two offline devices can't claim the same headroom atomically; blocking gives false safety. |

**Lens tension resolved.** *Product* wants instant checkout (offline, optimistic); *Architect*
wants server-authoritative money. Resolution: the **client shows an optimistic projection
immediately** (UX), but it is explicitly a **cache** — the server's derived projection is truth and
reconciles on pull (authority). The user is never blocked; correctness is never the client's.

---

## 3. Architecture

- **Logic location.** Validation runs **client (UX pre-check)** *and* **server (authority)**;
  postings run **server-only** in the posting service. Balance/outstanding are **derived**
  projections, never stored on masters.
- **Transaction boundaries.**
  - *Local:* each user action writes its event rows **and** enqueues its mutations in **one
    SQLite `withTransaction`** (atomic locally).
  - *Server:* each event insert **and** its derived `account_transaction`/ledger postings commit in
    **one DB transaction** (SD-1). A rejected event writes nothing.
- **Data authority (source of truth per fact).** Event tables = truth for *what happened*. Server
  posting service = truth for *balances/outstanding*. Client projection = cache. `guuid` = identity
  (client-minted, server-honoured). `row_version`/`modified_at` = server-owned. `store_fk`, totals,
  `created_by`, timestamps = **server-verified, never trusted from client**.
- **Concurrency.** Append-only: concurrent sales accumulate (no conflict). The only true races are
  *limit claims* (credit, one-open-shift) — resolved by **accept-and-flag + server reconciliation**,
  not locks.
- **Idempotency.** Every mutation carries a client `guuid`/`mutationId`; redelivery is a **no-op**.
  Corrections are new reversing events, never updates.
- **Failure semantics.** Local write durable before ack; queue retries with backoff; server rejects
  are terminal-with-message (DLQ for un-appliable); conflicts don't apply to append-only inserts.

---

## 4. The Flow

### 4.1 Primary flows
The numbered happy paths **F1–F8** are in [`accounts-and-ledger.md` §4](./accounts-and-ledger.md#4-runtime-flows-step-by-step)
and are not duplicated. Transaction boundaries: F2/F3/F5/F6 each = **one local tx** (event rows +
enqueue) then **one server tx** (event + postings).

### 4.2 Alternate flows
- **AF-1 (split tender).** F2 with N `sale_payment` rows across accounts → N postings, Σ = total.
- **AF-2 (card/UPI sale).** F2 tender to a Bank-kind account → posting lands on Bank, not Cash.
- **AF-3 (partial credit).** F5 with one `sale_payment(on_credit=true)` + one cash `sale_payment` →
  customer book gets the credit portion, cash book the paid portion.
- **AF-4 (partial refund).** F3 for a subset of `refund_line`s → sale → `partially_refunded`.
- **AF-5 (partial vendor payment).** F6 `amount < bill.amount_paise` → bill → `partially_paid`.
- **AF-6 (order settled on pickup).** F8 accept → sale paid by cash, no credit.
- **AF-7 (opening balance zero/absent).** F1 with no opening amount → no `opening_balance` event;
  balance starts at 0.

### 4.3 Exception flows
- **EF-1 (rejected sale).** Server rejects F2 (bad `store_fk`, unknown product, permission) → no
  event, no posting; client marks the mutation failed, **rolls back the optimistic projection**,
  shows the message; cart is restorable.
- **EF-2 (credit breach).** F5 server re-check fails → event **accepted**, `flagged` set, manager
  alert raised (EF, not a rejection — D6).
- **EF-3 (refund over cap).** F3 amount > sale net of prior refunds → **rejected**
  (`REFUND_EXCEEDS_SALE`), nothing posted.
- **EF-4 (allocation over-apply).** Settlement `Σ payment_allocation > payment.amount_paise` →
  **rejected** (`ALLOCATION_EXCEEDS_PAYMENT`).
- **EF-5 (dependency down / offline).** Sync unreachable → event stays queued (HIGH priority),
  applied on reconnect; nothing lost.
- **EF-6 (abandonment).** Cart never tendered → no event ever created (nothing to strand). A parked
  draft sale (SD-3) has a `draft` state with a manual discard.
- **EF-7 (duplicate delivery).** Same `guuid` arrives twice → server no-op; projection unchanged.
- **EF-8 (post to closed shift).** A late sale whose `shift_session` is already `closed` → **accepted
  as an adjustment**, does **not** rewrite the frozen close snapshot (companion PRD §15D).
- **EF-9 (act on archived account).** Tender to a soft-deleted/inactive account → **rejected**
  (`ACCOUNT_INACTIVE`).

---

## 5. Data & Fields

**Standard columns** (on every event table, omitted from the per-table tables below):
`id` uuid PK (server), `guuid` uuid unique (client-minted identity, **immutable**), `store_fk` uuid
req (**server-verified** against actor's store), `row_version` int (server), `modified_at` tstz
(server), `created_at` tstz (server), `created_by` uuid (server, from token), `device_fk` uuid,
`deleted_at` tstz null. Money fields are `integer` **paise**, `≥ 0` unless noted.

### 5.1 `payment_account` (existing `paymentAccounts` — reference)
Key fields used here: `id`, `name`, `kind` enum(`cash|bank|upi|card|wallet|other`), `isDefault`,
`isActive`, `isSystem`, `systemKey`(`cash|bank|null`). **No balance column** — balance is derived.

### 5.2 `account_transaction` (projection — server-derived, not synced as truth)
| Field | Type | Req | Default | Constraints | Immutable | Lives |
|---|---|---|---|---|---|---|
| `account_fk` | uuid | ✓ | — | FK payment_account, active | ✓ | server + local cache |
| `direction` | enum | ✓ | — | `credit|debit` | ✓ | " |
| `amount_paise` | int | ✓ | — | `> 0` | ✓ | " |
| `reason` | enum | ✓ | — | `opening_balance|float|payin|payout|drop|tip|count|variance|sale|refund|vendor_payment|credit_payment` | ✓ | " |
| `source_type` | enum | ✓ | — | `sale|refund|cash_movement|opening|shift` | ✓ | " |
| `source_fk` | uuid | ✓ | — | FK to the source event | ✓ | " |
| `shift_session_fk` | uuid | ✗ | null | FK shift_session | ✓ | " |
| `note` | text | ✗ | null | ≤ 280 | ✓ | " |

### 5.3 `opening_balance` (event)
| Field | Type | Req | Constraints |
|---|---|---|---|
| `account_fk` | uuid | ✓ | FK payment_account, `isSystem` cash/bank |
| `amount_paise` | int | ✓ | `> 0` |
| `as_of` | date | ✓ | = store create date |

### 5.4 `cash_movement` (event)
| Field | Type | Req | Default | Constraints |
|---|---|---|---|---|
| `account_fk` | uuid | ✓ | — | FK, active |
| `shift_session_fk` | uuid | ✓ | — | FK, status ∈ open/paused |
| `type` | enum | ✓ | — | `payin|payout|drop|tip` |
| `reason` | text | cond | null | **required when** `type ∈ {payout, drop}` (BR-7); ≤ 280 |
| `amount_paise` | int | ✓ | — | `> 0` |
| `by_user_fk` | uuid | ✓ | server | from token |

### 5.5 `shift_session` (event + mutable status projection)
`register_fk` uuid req; `device_fk`; `opened_by_user_fk`; `opened_at` tstz; `opening_float_paise`
int ≥0; `status` enum(`open|paused|counting|closing|closed|force_closed`); `counted_cash_paise` int
null; `expected_cash_paise` int null (**server-derived**); `variance_paise` int null (**derived** =
counted − expected); `closed_by_user_fk`; `closed_at`. Detail in companion PRD §16.

### 5.6 `denomination_count` (event)
`shift_session_fk` req; `phase` enum(`opening|closing`); `denomination_paise` int req `>0`;
`count` int req `≥0`; `is_draft` bool default true.

### 5.7 `sale` / `sale_line` / `sale_payment`
**`sale`:** `customer_fk` uuid null (**required when** any `sale_payment.on_credit=true` — BR-2);
`shift_session_fk` uuid req; `total_paise` int req `>0` (**server-recomputed** from lines — BR-1);
`status` enum(`draft|completed|partially_refunded|refunded|voided`) default `completed` (`draft`
only for parked carts); `invoice_no` text (server-assigned from `stores.invoicePrefix/Counter`);
`sold_at` tstz (**server-stamped**).
**`sale_line`:** `sale_fk` req; `product_fk` req; `qty` int `>0`; `unit_price_paise` int `≥0`
(server-verified vs product); `discount_paise` int ≥0 default 0; `line_total_paise` int
(**server-computed** = qty·unit − discount). Immutable once `sale.status=completed`.
**`sale_payment`:** `sale_fk` req; `account_fk` req (active); `tender` enum(`cash|card|upi|wallet|
other`); `amount_paise` int `>0`; `on_credit` bool default false (`account_fk` null allowed **iff**
`on_credit=true`).

### 5.8 `refund` / `refund_line`
**`refund`:** `sale_fk` req (target `status ∈ completed/partially_refunded`); `customer_fk` (copied
from sale); `account_fk` req (refund destination, active); `amount_paise` int `>0`
(**server-capped** at sale net of prior refunds — BR-4); `shift_session_fk` req; `reason` text ≤280.
**`refund_line`:** `refund_fk`; `sale_line_fk` req (belongs to `refund.sale_fk`); `qty` int `>0`
(≤ line qty net of prior); `amount_paise` int (server-computed).

### 5.9 `customer_ledger_event` (event)
`customer_fk` req; `kind` enum(`credit_sale|payment|adjustment`); `amount_paise` int `>0`;
`source_fk` uuid (sale for credit_sale, payment for payment); `flagged` bool default false
(set by server on limit breach — D6).

### 5.10 `supplier_bill` / `supplier_payment`
**`supplier_bill`:** `supplier_fk` req; `bill_no` text; `amount_paise` int `>0`; `bill_date` date;
`due_date` date null; `status` enum(`open|partially_paid|paid|void`) default `open`
(**server-derived** from allocations — BR-8).
**`supplier_payment`:** `bill_fk` null (null = on-account); `supplier_fk` req; `account_fk` req
(active); `amount_paise` int `>0`; `signature_attachment_fk` uuid null (FK files); `paid_at` tstz.

### 5.11 `payment_allocation` (event — D10)
`payment_fk` uuid req (a `sale_payment`/customer payment or `supplier_payment`); `target_type`
enum(`sale|bill`); `target_fk` uuid req; `applied_paise` int `>0`
(Σ per payment ≤ payment amount — BR-5; Σ per target ≤ target amount — BR-6).

### 5.12 `order` / `order_item`
**`order`:** `customer_fk` req (credit-enabled — BR-9); `status`
enum(`pending|accepted|rejected|fulfilled`) default `pending`; `linked_sale_fk` uuid null (set on
accept, **immutable once set** — SD-4); `note` text ≤280.
**`order_item`:** `order_fk`; `product_fk` req; `qty` int `>0`.

**Retained/audited:** every event table is append-only and retained indefinitely; `created_by` +
`device_fk` on all; shift close snapshot is immutable (PRD §15D).

---

## 6. Validations

Layer: **C** = client (UX pre-check), **S** = server (authority). Security/money validations are
**S-mandatory**; C is convenience only.

| ID | Field(s) | Rule | Layer | Failure behaviour | Exact message |
|---|---|---|---|---|---|
| V-1 | `amount_paise` (all) | integer, `> 0` | C+S | reject before write | "Enter an amount greater than ₹0." |
| V-2 | `account_fk` | exists, `isActive`, same store | C+S | reject | "This account is inactive and can't be used." |
| V-3 | `sale.total_paise` | = Σ `sale_line.line_total_paise` | S | reject | "Cart total doesn't match its items. Please retry." |
| V-4 | `sale_payment` Σ | = `sale.total_paise` (paid + credit portions) | S | reject | "Payment doesn't add up to the total." |
| V-5 | `sale.customer_fk` | required when any `on_credit=true` | C+S | reject | "Select a customer to sell on credit." |
| V-6 | credit headroom | `outstanding + credit_amount ≤ creditLimit` (unless `overrideCreditLimit`) | C (advisory) / S (flag) | C: warn+allow; S: accept+flag | C: "This exceeds the customer's credit limit (₹X left)." |
| V-7 | `cash_movement.reason` | required when `type ∈ {payout, drop}` | C+S | reject | "Add a reason for this cash-out." |
| V-8 | large amount | `amount_paise > storeThreshold` needs `CashMovement:LARGE_AMOUNT` | S | reject if lacking | "You don't have permission for cash movements this large." |
| V-9 | `refund.amount_paise` | ≤ sale total − Σ prior refunds | C+S | reject | "Refund can't exceed the remaining refundable amount (₹X)." |
| V-10 | `refund.sale_fk` | status ∈ completed/partially_refunded | S | reject | "This sale can't be refunded." |
| V-11 | `payment_allocation` per payment | Σ `applied_paise` ≤ payment amount | S | reject | "Allocated amount exceeds the payment." |
| V-12 | `payment_allocation` per target | Σ `applied_paise` ≤ target outstanding | S | reject | "This bill is already fully settled." |
| V-13 | `order.customer_fk` | credit-enabled customer | C+S | reject | "Only credit customers can place orders." |
| V-14 | `denomination_count.count` | integer ≥ 0 | C+S | reject | "Enter a valid count." |
| V-15 | `shift_session` for movement | status ∈ open/paused | S | reject | "Open a shift before recording cash." |
| V-16 | `store_fk`/`created_by` | match token's store & user | S | reject (never trust client) | "Something went wrong. Please sign in again." |
| V-17 | `guuid` | well-formed uuid, unique-per-entity | S | duplicate → **no-op** (not error) | — |

---

## 7. Business Rules

| ID | Rule | Type | Enforced where | Violation behaviour |
|---|---|---|---|---|
| BR-1 | `sale.total_paise` = Σ line totals (server-recomputed; client value ignored) | invariant | S (posting) | reject `SALE_TOTAL_MISMATCH` |
| BR-2 | A credit sale requires a `customer_fk` | invariant | S + C | reject `CREDIT_SALE_NO_CUSTOMER` |
| BR-3 | Every posting is server-derived; client never writes `account_transaction` | invariant | S (only posting service inserts) | client rows ignored/dropped |
| BR-4 | Σ refunds for a sale ≤ sale total | invariant | S | reject `REFUND_EXCEEDS_SALE` |
| BR-5 | Σ allocations per payment ≤ payment amount | invariant | S | reject `ALLOCATION_EXCEEDS_PAYMENT` |
| BR-6 | Σ allocations per target ≤ target outstanding | invariant | S | reject `TARGET_OVER_SETTLED` |
| BR-7 | `payout`/`drop` require a reason | policy | S + C | reject `CASH_REASON_REQUIRED` |
| BR-8 | `supplier_bill.status` derived from allocations (open/partial/paid) | invariant | S | recompute on each allocation |
| BR-9 | Only credit-enabled customers place orders | policy | S + C | reject `ORDER_NOT_CREDIT_CUSTOMER` |
| BR-10 | Credit limit is **advisory offline**; server accepts + flags on breach | policy | S | set `flagged`, alert manager |
| BR-11 | `variance` is derived (counted − expected); never client-authored | invariant | S | ignore client variance |
| BR-12 | Postings are archive-only; a system Cash/Bank account is never deletable | invariant | DB + S | reject delete |
| BR-13 | A closed shift's snapshot is immutable; late events post as adjustments | invariant | S | append adjustment, don't rewrite |
| BR-14 | Every money mutation is idempotent by `guuid` | invariant | S | redelivery = no-op |
| BR-15 | Permissions judged at **action time** (offline), not sync time | policy | S (stamped `created_by`+captured caps) | reject if lacked at action time |

---

## 8. State Machines

**`sale.status`** — `draft → completed`; `completed → partially_refunded → refunded`;
`completed → voided`; `partially_refunded → voided`.
*Illegal (reject):* `completed → draft`, `refunded → completed`, `voided → *`, `refunded → partially_refunded`.

**`refund`** — terminal on create (`posted`); reversal only by a compensating refund/void. No back-transition.

**`order.status`** — `pending → accepted`; `pending → rejected`; `accepted → fulfilled`.
*Illegal (reject):* `rejected → accepted`, `fulfilled → pending`, `accepted → rejected` after
`linked_sale_fk` set, any transition out of `rejected`/`fulfilled`.

**`supplier_bill.status`** — `open → partially_paid → paid`; `open → void`.
*Illegal:* `paid → open` (except via a reversing payment event), `void → *`.

**`shift_session.status`** — `open ↔ paused`; `open/paused → counting → closing → closed`;
`* → force_closed` (privileged). *Illegal:* `closed → open` (except `Shift:REOPEN` special),
`closed → counting`. Full machine in companion PRD §11.

**`cash_movement`, `opening_balance`, `denomination_count`, `payment_allocation`, `account_transaction`** —
stateless immutable events (no lifecycle; corrections = new reversing events).

---

## 9. Edge Cases & Scenarios (catalogue walk)

| ID | Scenario | Expected behaviour | Relates |
|---|---|---|---|
| EC-1 | Two devices cash-sell offline simultaneously | Both events accumulate; both cash-in postings apply; balance = sum. No conflict. | D1, concurrency |
| EC-2 | Two devices credit-sell same customer, both under limit locally, together over | Both accepted; server flags the breach + alerts manager. | D6, BR-10 |
| EC-3 | Server rejects a sale after optimistic UI | Client rolls back the projection, restores cart, shows message. | EF-1 |
| EC-4 | Same sale mutation delivered twice | Second is a no-op (guuid). | BR-14, V-17 |
| EC-5 | Refund of full amount then another refund | Second rejected `REFUND_EXCEEDS_SALE`. | BR-4, V-9 |
| EC-6 | Device offline for a week, then syncs | All queued events apply in FK order; balances reconcile; late sales into closed shifts = adjustments. | EF-8, BR-13 |
| EC-7 | Clock skew on a device | Ordering uses server `modified_at`; day/shift association uses `shift_session_fk`, not wall-clock. | §3 |
| EC-8 | Tampered client posts fake `credit_payment` | Ignored — only the posting service inserts `account_transaction`. | BR-3 |
| EC-9 | Split tender where Σ ≠ total | Rejected `PAYMENT_MISMATCH`. | V-4 |
| EC-10 | `payout` with no reason | Rejected `CASH_REASON_REQUIRED`. | BR-7 |
| EC-11 | Cash movement over threshold without permission | Rejected `LARGE_AMOUNT_FORBIDDEN`. | V-8 |
| EC-12 | Balance screen on an account with 100k rows | Read uses checkpoint + rows since; bounded. (Pre-checkpoint: flagged perf watch-item.) | §7 watch-list |
| EC-13 | Delete a payment account that has history | Rejected; archive-only. | BR-12 |
| EC-14 | Order accepted twice (double-tap) | Second no-op; `linked_sale_fk` immutable once set. | SD-4, order SM |
| EC-15 | App killed mid cash-count | Draft denominations already persisted per keystroke; resume from local. | 5.6, PRD §14B |
| EC-16 | Refund to a different account than the sale | Allowed; posts debit to the chosen active account. | AF, V-2 |
| EC-17 | Zero opening balance | No `opening_balance` event; account starts at 0. | AF-7 |
| EC-18 | Permission revoked between action (offline) and sync | Judged by caps at action time; if lacked then → reject. | BR-15 |

---

## 10. Error Handling & Messages

| Failure | Where | Outcome | Surface | Exact message |
|---|---|---|---|---|
| `SALE_TOTAL_MISMATCH` | server posting | reject, nothing written | checkout toast | "Cart total doesn't match its items. Please retry." |
| `PAYMENT_MISMATCH` | server | reject | checkout | "Payment doesn't add up to the total." |
| `CREDIT_SALE_NO_CUSTOMER` | client+server | block submit | checkout | "Select a customer to sell on credit." |
| `CREDIT_LIMIT_EXCEEDED` (advisory) | client | warn, allow | credit toggle | "This exceeds the customer's credit limit (₹X left). Continue?" |
| credit breach (server) | server | accept + flag | manager alert feed | "Credit limit exceeded on an offline sale — review required." |
| `REFUND_EXCEEDS_SALE` | server | reject | refund screen | "Refund can't exceed the remaining refundable amount (₹X)." |
| `CASH_REASON_REQUIRED` | client+server | block | add-transaction | "Add a reason for this cash-out." |
| `LARGE_AMOUNT_FORBIDDEN` | server | reject | add-transaction | "You don't have permission for cash movements this large." |
| `ACCOUNT_INACTIVE` | client+server | reject | tender/refund | "This account is inactive and can't be used." |
| `ALLOCATION_EXCEEDS_PAYMENT` | server | reject | collect-payment | "Allocated amount exceeds the payment." |
| `SHIFT_NOT_OPEN` | server | reject | POS/cash | "Open a shift before recording cash." |
| `ORDER_NOT_CREDIT_CUSTOMER` | client+server | reject | order | "Only credit customers can place orders." |
| sync unreachable | client | queue + retry | subtle banner | "Saved. Will sync when you're back online." |
| unexpected server error | server | reject, no side-effect | toast | "Something went wrong. Nothing was charged. Please try again." |

**Never:** a raw code/stack to the user; a silent drop; a success toast for a queued-but-unconfirmed
money event without the "will sync" qualifier; a dead-end with no retry/discard.

---

## 11. UX & Product Design

- **Account-detail:** projection list; top filter chips `All · Cash In · Cash Out` (+ reason);
  header = **total balance** (not per-row running). States: loading skeleton, empty ("No
  transactions yet"), error (retry), offline banner. "Add transaction" FAB → sheet.
- **Add-transaction sheet:** Debit/Credit segmented → reason (`payin·payout·float`) → amount
  (numeric pad, paise) → note. Reason field appears required for payout/drop. Confirm on submit.
- **Checkout:** tender selector reads active `paymentAccounts`; split-tender adds rows; "Pay on
  credit" appears only for qualifying customers, shows remaining headroom; optimistic success with
  "will sync" if offline.
- **Refund:** pick original sale → lines → destination account → reason → confirm (destructive-style
  confirm since it moves money out).
- **Vendor pay:** vendor → bill → amount → account → **signature capture pad** → Pay; signature is
  required to enable Pay.
- **Order queue:** pending list with Accept/Reject; Accept shows the created sale.
- **Must never happen:** lost cart on a rejected sale; a refund with no confirm; a money event that
  looks committed but silently failed; a per-row running balance that disagrees across devices.

---

## 12. Acceptance Criteria & Definition of Done

**Critical (money/auth/integrity) — must pass:**
- AC-1 A cash sale posts exactly one `credit/sale` per `sale_payment`; Σ postings = total. (BR-1, V-4)
- AC-2 A rejected sale leaves **no** `account_transaction`. (SD-1, EF-1)
- AC-3 A client-authored `account_transaction` is ignored by the server. (BR-3)
- AC-4 A refund is capped server-side at sale net of prior refunds. (BR-4, V-9)
- AC-5 A duplicate mutation `guuid` is a no-op. (BR-14)
- AC-6 A credit sale that breaches the limit offline is accepted and **flagged**, not dropped. (D6, BR-10)
- AC-7 `payout`/`drop` without a reason is rejected on both layers. (BR-7)
- AC-8 A large cash movement without `CashMovement:LARGE_AMOUNT` is rejected. (V-8)
- AC-9 Balance = opening + Σcredits − Σdebits, identical on two synced devices. (SD-2)
- AC-10 System Cash/Bank account cannot be deleted. (BR-12)

**High:**
- AC-11 Split tender across Cash + Bank posts to both. (AF-1/2)
- AC-12 Settlement allocates to specific sales/bills; over-apply rejected. (D10, BR-5/6)
- AC-13 Order accept creates one linked sale; second accept is a no-op. (EC-14)
- AC-14 Late sale into a closed shift posts as an adjustment, snapshot unchanged. (BR-13)
- AC-15 Cash-count draft survives an app kill. (EC-15)

**DoD gate:** all Critical AC automated + passing; every BR has a satisfied **and** a violated test;
every state machine's illegal transitions rejected; offline + concurrency + permission-at-action-time
covered; every message wired with the exact wording above.

---

## 13. Assumptions & Open Questions

**Assumptions (labelled):**
- A-1 One open shift per register per store; POS actions require an open shift (V-15). *Proposal —
  confirm against how strictly you want to gate sales on shifts.*
- A-2 Refund destination account is chooseable (not forced to the original tender). *Proposal.*
- A-3 `draft` sale (parked cart) is in scope but low priority. *Proposal — could defer.*

**Open questions (each with a proposed default):**
- OQ-1 **Cash-book vs full double-entry (D9)** — *default: cash-book now.* Blocks whether `sale`
  postings include Income/Tax/AR.
- OQ-2 **Credit=IN direction (D2)** — *default: confirm as-is.*
- OQ-3 **On-account vendor payment** (`supplier_payment.bill_fk` null) — allowed? *Default: yes,
  allocate later.*
- OQ-4 **Store-level large-amount threshold** value + whether per-role. *Default: single store config.*
- OQ-5 **Shift gating strictness** (A-1) — hard block or warn? *Default: hard block for cash tenders,
  warn for card.*