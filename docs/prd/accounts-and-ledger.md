# Accounts, Cash & Ledger — Implementation Flow

> **Status:** Design + implementation flow (greenfield). Not a description of current code.
> **Scope:** Payment accounts as ledgers, cash in/out, POS sale & refund, customer credit,
> vendor bills/payments, orders — all offline-first over the existing sync engine.
> **Companion docs:** [`shifts-and-cash-management.md`](./shifts-and-cash-management.md),
> [`payment-accounts.md`](./payment-accounts.md), [`customers.md`](./customers.md),
> [`suppliers.md`](./suppliers.md).

This document is the corrected, final flow after a critic pass. Two calls were reversed from the
first draft and are marked **[reversed]** where they appear:
- Money truth lives in **events**, not in client-authored ledger rows.
- `cash_movement` stays its **own** table (not collapsed into the ledger); `variance`/`count` are
  **derived**, never hand-typed.

---

## 0. Locked decisions

| # | Decision | Committed default | Why |
|---|----------|-------------------|-----|
| D1 | Authorship **[reversed]** | Events are the synced source of truth. `account_transaction` is a **derived, rebuildable projection** the server re-derives and owns. The client never authors sale-derived money rows. | Prevents torn state (cash with no sale) and closes the trust boundary (client can't mint cash). Matches `shifts-and-cash-management.md` §15G server reconciliation. |
| D2 | Direction convention | **Credit = money IN, Debit = money OUT.** | Bank-statement mental model staff already know. Everything signs off this. |
| D3 | `cash_movement` **[reversed]** | Its own event table (payin/payout/drop/tip). Not collapsed into the ledger. | Keeps the drawer-movement domain event first-class; the ledger is a view over it. |
| D4 | Variance / count **[reversed]** | **Derived**: `variance = counted − expected`; `count` comes from the count screen. Never a manual reason. | A hand-typed variance is forgeable and meaningless. |
| D5 | Cash counts | **Anchored to a `shift_session`** from day one (full X/Z ceremony deferred). | Association over wall-clock makes variance and day boundaries well-defined offline. |
| D6 | Credit limit offline | **Advisory locally, re-verified + flagged server-side.** Never a hard offline guarantee. | Two offline devices can't atomically claim the same credit headroom; same class as one-open-shift-per-register. |
| D7 | Projection storage | **Stored local table, rebuildable from events.** | Fast mobile reads; repair = rebuild from events. |
| D8 | Multi-device | Assume **multiple devices per store** (safe superset). | If a store is single-device the design still holds; the reverse is not true. |
| D9 | Cash-book now, GL-ready later | Post **only cash movements** to `account_transaction`; design events so a **full double-entry posting service (Income/Tax/AR) can be added later without reshaping events.** | Reference `ayphen-3.0` is full double-entry, but P&L/tax GL is weight the offline POS doesn't need yet. Keep the upgrade path open (see §10). |
| D10 | Invoice/bill-level allocation | Settlement links a payment to **specific** sales/bills with an applied amount (`payment_allocation`). Not a lump balance. | Borrowed from reference `TransactionLink` + `AppliedCredits`; a lump balance can't answer "which bill did this pay." |
| D11 | Order status machine | `pending → accepted / rejected → fulfilled`; accept is an explicit action; convert to sale **by link, not mutation**. | Reference `TDSO` status flow + `PO_SO`/`EST_INV` link-conversion is the proven shape. |

---

## 1. Core idea — three books, one derived ledger

Every money event moves value between three "books":

| Book | What it answers | Backing |
|------|-----------------|---------|
| **Account** (cash / bank / UPI) | "click Cash → cash in / cash out" | `account_transaction` projection |
| **Customer** (receivables) | "how much does this credit customer owe" | `customer_ledger_event` |
| **Supplier** (payables) | "how much do we owe this vendor" | `supplier_bill` − `supplier_payment` |

A **credit sale** touches only the customer book — no cash account moves until the customer pays.
That is the whole reason the books are separate (lightweight double-entry).

---

## 2. Data model — two layers

### Layer A — Event tables (synced source of truth, append-only)

| Table | Purpose | Key columns (beyond sync/audit) |
|-------|---------|----------------------------------|
| `sale` | a sale header | `store_fk`, `customer_fk?`, `shift_session_fk`, `total_paise`, `status` |
| `sale_line` | line items | `sale_fk`, `product_fk`, `qty`, `unit_price_paise`, `line_total_paise` |
| `sale_payment` | tenders on a sale | `sale_fk`, `account_fk`, `tender`, `amount_paise`, `on_credit` (bool) |
| `refund` | refund against a sale | `store_fk`, `sale_fk`, `customer_fk?`, `account_fk`, `amount_paise`, `shift_session_fk` |
| `refund_line` | refunded lines | `refund_fk`, `sale_line_fk`, `qty`, `amount_paise` |
| `cash_movement` | manual drawer money | `shift_session_fk`, `account_fk`, `type` (payin/payout/drop/tip), `amount_paise`, `reason`, `by_user_fk` |
| `shift_session` | open/count/close state | `register_fk`, `status`, `opening_float_paise`, `counted_cash_paise`, `expected_cash_paise`, `variance_paise` |
| `denomination_count` | crash-safe cash count | `shift_session_fk`, `phase` (opening/closing), `denomination_paise`, `count`, `is_draft` |
| `customer_ledger_event` | receivables movements | `customer_fk`, `kind` (credit_sale/payment/adjustment), `amount_paise`, `source_fk` |
| `supplier_bill` | payable owed to a vendor | `supplier_fk`, `amount_paise`, `status` |
| `supplier_payment` | payment against a bill | `bill_fk`, `account_fk`, `amount_paise`, `signature_attachment_fk` |
| `payment_allocation` | matches a payment to a specific sale/bill (D10) | `payment_fk`, `target_type` (sale/bill), `target_fk`, `applied_paise` |
| `order` | pre-sale request | `customer_fk`, `status` (pending/accepted/rejected/fulfilled), `linked_sale_fk?`, `shift_session_fk?` |
| `order_item` | order lines | `order_fk`, `product_fk`, `qty` |

Every event table carries `...syncColumns()` (`guuid`, `row_version`, `modified_at`) +
`...auditColumns`, a `sync_touch_row` trigger, and pushes through the **append-only handler**
(§3), never `MasterDataSyncHandler`.

> `MasterDataSyncHandler` version-gates every update as a conflict — wrong here: two concurrent
> cash sales are both valid, not a `row_version` conflict. See its own caveat at
> `apps/backend/src/sync/push/master-data.handler.ts` (~L78).

### Layer B — Projections (derived, rebuildable, never synced as truth)

| Projection | Derived from | Read by |
|------------|-------------|---------|
| `account_transaction` | `sale_payment`, `refund`, `cash_movement`, `opening_balance`, derived `variance` | **Account-detail screen** (cash in/out + filters) |
| account balance | Σ over `account_transaction` (+ checkpoint later) | account header |
| `customer_outstanding` | Σ `customer_ledger_event` | credit gate, statement |
| `supplier_outstanding` | Σ `supplier_bill` − Σ `supplier_payment` | vendor screen |

**`account_transaction` columns (projection):**
```
id, guuid, store_fk,
account_fk        → payment_accounts.id
direction         'credit' | 'debit'          (credit = IN, debit = OUT)
amount_paise      integer
reason            opening_balance | float | payin | payout | drop | tip |
                  count | variance | sale | refund |
                  vendor_payment | credit_payment
source_type       'sale' | 'refund' | 'cash_movement' | 'opening' | 'shift'
source_fk         uuid                          (the event it was derived from)
shift_session_fk  uuid (nullable)
note              text
created_at, created_by, device_fk
```

A projection row is **never enqueued to sync**. The server derives it in the same transaction as
the event; each device rebuilds its local copy by folding the events it has. Repair = rebuild
from events.

---

## 3. Phase 0 — Append-only sync foundation (blocks all money tables)

Non-negotiable prerequisite.

1. **`AppendOnlySyncHandler`** beside `master-data.handler.ts`: insert-only, idempotent by client
   `guuid` (redelivery = no-op, no `row_version` gate). Corrections are new reversing events.
2. **Posting service** (backend): given a synced domain event, derive the `account_transaction`
   projection rows **in the same DB transaction** as the event insert. This is the
   "sale → postings" expander and the thing that keeps cash bound to its sale.
3. **Custom pull filters** for the append-only tables (implement `SyncEntityFilter` directly, like
   `StaffSyncFilter` — not `GenericSyncFilter`), keyset on `(modified_at, id)`, unique FK-safe
   `dependencyOrder`.
4. **Queue priority:** sale/refund/payment/cash_movement mutations = **HIGH**; respect FK order
   (sale → sale_line → sale_payment; session → its movements; order → order_item).
5. **Money helper:** integer paise everywhere (extend `payload-helpers.ts`).

**Exit test:** one append-only event round-trips device-A → server (posting service writes the
projection) → pull → device-B, idempotent under redelivery.

---

## 4. Runtime flows (step by step)

### F1 — Store create → opening balance
1. Owner creates store → `store.service.ts` seeds locked Cash + Bank `paymentAccounts` (existing).
2. If an opening amount was supplied → emit an `opening_balance` event per account (add the field
   to the create-store DTO).
3. Server posting service → `account_transaction(credit, opening_balance)`. Balance starts correct.

### F2 — Cash sale
1. Cashier builds cart, tenders to Cash (or Bank) → **one local SQLite tx**: insert `sale` +
   `sale_line` + `sale_payment`, enqueue as FK-ordered mutations, `requestImmediateSync()`.
2. Client folds its **local projection** optimistically (shows cash in) — a cache, not truth.
3. On push: server inserts the sale rows and, **in the same tx**, the posting service derives
   `account_transaction(credit, sale)` on the tendered account. Split tender → one posting per
   `sale_payment`.
4. Pull returns the server-derived projection; the local cache reconciles. If the sale is rejected
   server-side, **no posting exists** — no orphan cash.

### F3 — Refund
1. Refund screen: **amount + customer + original sale** → insert `refund` (+ `refund_line`),
   enqueue.
2. Server posts `account_transaction(debit, refund)` to the refunding account (cash → Cash,
   card/UPI → Bank). Derived, not client-sent.

### F4 — Manual cash in/out ("Add transaction" button)
1. Account-detail → **Add transaction** → **Debit / Credit** → reason limited to
   **payin / payout / float** → amount → note.
2. Insert `cash_movement(type, reason, account_fk, shift_session_fk)`, enqueue. Large amounts gated
   by the `CashMovement:LARGE_AMOUNT` special action.
3. Server posts the matching `account_transaction`.
   `count` / `variance` are **not** created here — they come from F7.

### F5 — Credit sale (customer credit enabled)
1. At checkout, "Pay on credit" is offered **only** if `customers.creditLimit` /
   `overrideCreditLimit` qualifies **and** local `customer_outstanding + amount ≤ limit`
   (advisory, per D6).
2. Insert `sale` + `sale_payment(on_credit=true)` + `customer_ledger_event(credit_sale)`.
   **No `account_transaction`** — no cash moved.
3. Server re-checks the limit; if breached by concurrent offline sales it **accepts the event and
   raises a flag/alert** — it does not silently reject a completed offline sale.
   `overrideCreditLimit` skips the check entirely (BR-CUS-025).
4. **Settlement later:** "Collect payment" → a `payment` event + `customer_ledger_event(payment)`
   + one `payment_allocation` per settled sale (D10) → server posts
   `account_transaction(credit, credit_payment)`. Double-entry moment: customer book down, cash
   book up, and the payment is matched to specific sales (not just a lump balance).

### F6 — Vendor bill → payment → signature
1. Select vendor → open/select `supplier_bill`.
2. Enter payment → **select account (Cash)** → **capture signature** (reuse the files/attachments
   pipeline; `supportsAttachments` is already a per-entity flag in `entity-catalogue.ts`) → **Pay**.
3. Insert `supplier_payment(bill_fk, account_fk, signature_attachment_fk)`, enqueue.
4. Server posts `account_transaction(debit, vendor_payment)` (cash out) and reduces
   `supplier_outstanding`. Signature stored on the payment as proof of receipt.

### F7 — Cash count / variance (shift-anchored)
1. Count screen writes **each denomination to `denomination_count` as entered** (crash-safe draft,
   `phase=closing`).
2. On submit → `counted_cash_paise`; **expected** =
   `opening_float + cash_sales − cash_refunds + payins − payouts − drops` (folded from events);
   **variance = counted − expected** (derived).
3. Emit the close/count event; server re-derives `expected` from events (reconciliation, see
   companion §15G) and confirms/flags the variance. Variance surfaces in the account ledger as a
   derived `account_transaction(variance)` — credit if over, debit if short.

### F8 — Order (credit customer places, store accepts)
1. A credit-enabled customer places an `order` → `status = pending` in the store's queue.
2. Staff **accept / reject** — each transition is an append event, not an in-place mutation.
3. On accept → creates a **linked** Sale (F2) via `order.linked_sale_fk` (convert-by-link, not
   mutation, per D11); the sale may go on credit (F5) or settle on pickup. Reject is terminal.

---

## 5. Account-detail screen (the view requested)

- Tap **Cash** → reads the **local `account_transaction` projection** for that `account_fk`.
- **Filter chips pinned at the top:** `All · Cash In · Cash Out` (+ optional reason).
  Cash Out = `direction = debit`.
- Header shows the **current total balance** — not a per-row running balance (running balance is
  only well-defined after server ordering across devices).
- **Add transaction** → F4.

---

## 6. Per-table build checklist (repeat for every event table)

1. `schema.ts` table + sync index + `sync_touch_row` trigger → `db:generate`.
2. `sync.constants.ts` — add to the `SyncEntityType` union.
3. **Append-only** push handler + register in `sync.module.ts` (providers **and** the registry
   factory `inject` array).
4. Custom pull filter in `sync-filter.registry.ts` (unique `dependencyOrder`, FK-safe).
5. **Posting service** rule: event → projection rows (same tx).
6. `entity-catalogue.ts` + every role matrix in `role-matrices.ts` (Store Owner FULL, default
   VIEW_CREATE). `Shift` / `CashMovement` already exist.
7. Mobile `core/sync/db/schema.ts` mirror (+ local projection table) → `db:generate`.
8. Mobile `createSyncedTableRepository` + `enqueueCreate…` (copy the supplier enqueue: upsert local
   row + queue mutation in one `withTransaction`).
9. Mobile feature screens + optimistic local projection fold.

---

## 7. Implementation plan (phase by phase)

Each phase lists its goal, backend tasks, mobile tasks, RBAC, and an exit criterion. Every new
table also runs the fixed 9-step checklist in §6.

### Phase 0 — Foundations (blocks everything)
**Goal:** prove the append-only + posting + projection pattern end-to-end on one entity.
- **Backend:** `AppendOnlySyncHandler` beside `master-data.handler.ts` (insert-only, idempotent by
  `guuid`, no `row_version` gate; corrections = reversing events). **Posting service** (event →
  `account_transaction` in the same DB tx). **Projection-rebuild** routine (fold events → projection;
  the repair path). Custom pull filter (implement `SyncEntityFilter` directly, unique FK-safe
  `dependencyOrder`). Money = integer paise helper. Mutation-queue HIGH priority for money events +
  FK ordering.
- **Exit:** one append-only event round-trips A → server (posting writes projection) → pull → B,
  idempotent under redelivery.

### Phase 1 — Account ledger + opening balance + manual cash + Account-detail screen
**Goal:** the entire account-centric view. Delivers F1, F4 (and F7 alongside).
- **Backend:** tables `account_transaction` (projection), `cash_movement` + `opening_balance`
  (events); triggers; `SyncEntityType`; append-only handlers; posting rules
  (`cash_movement`/`opening_balance` → `account_transaction`). Store-create: opening-amount DTO
  field → emit `opening_balance` per seeded Cash/Bank account.
- **RBAC:** reuse existing `CashMovement` entity (already in `entity-catalogue.ts` + role matrices);
  add `AccountTransaction` if view-scoping is wanted. Large amounts → `CashMovement:LARGE_AMOUNT`.
- **Mobile:** mirror the 3 tables + local projection; `createSyncedTableRepository` +
  `enqueueCreateCashMovement`. **Account-detail screen** (projection list, top chips
  `All·Cash In·Cash Out`, header = total balance). **Add-transaction sheet** (Debit/Credit → reason
  `payin·payout·float` → amount → note).
- **F7 alongside:** `shift_session` + `denomination_count`; `variance = counted − expected` derived
  → posts `account_transaction(variance)`. Full X/Z ceremony deferred.
- **Exit:** create store with opening balance → tap Cash → see opening + a manual payout, filtered,
  balance correct, synced to a second device.

### Phase 2 — Sale + refund
**Goal:** revenue core. Delivers F2, F3. Builds out `PosScreen.tsx` (currently a shell).
- **Backend:** tables `sale`, `sale_line`, `sale_payment`, `refund`, `refund_line`; handlers;
  filters; posting rules (`sale_payment` → `account_transaction(credit, sale)`; `refund` →
  `debit, refund`). Split tender = one posting per `sale_payment`.
- **RBAC:** `Sale` / `Refund` entities + role matrices.
- **Mobile:** repos + `enqueueCreateSale` (sale + lines + payment in one `withTransaction`,
  FK-ordered) + `enqueueCreateRefund`. POS cart, tender selection (reads `paymentAccounts`),
  checkout → optimistic projection fold. Refund screen (amount + customer + original sale).
- **Exit:** cash sale posts cash-in; card sale posts to Bank; split tender posts two rows; refund
  posts cash-out; a rejected sale leaves **no orphan posting**.

### Phase 3 — Customer credit + outstanding + settlement
**Goal:** F5 + D10 allocation.
- **Backend:** tables `customer_ledger_event` (credit_sale/payment/adjustment); `payment_allocation`
  (payment → sale, `applied_paise`). Posting: credit sale → `customer_ledger_event(credit_sale)`,
  **no `account_transaction`**; settlement → `customer_ledger_event(payment)` + `payment_allocation`
  rows + `account_transaction(credit, credit_payment)`. `customer_outstanding` projection =
  Σ `customer_ledger_event`. Server re-checks credit limit, **accepts + flags** on breach (D6);
  `overrideCreditLimit` skips (BR-CUS-025).
- **Mobile:** checkout "Pay on credit" gated on local outstanding (advisory). "Collect payment"
  screen with per-sale allocation. Customer detail → outstanding + statement.
- **Exit:** credit sale moves the customer book only; payment settles specific sales and lands cash;
  concurrent offline over-limit sales both persist and raise a server flag.

### Phase 4 — Vendor bill + payment + signature
**Goal:** F6.
- **Backend:** tables `supplier_bill`, `supplier_payment` (+ `signature_attachment_fk`);
  `payment_allocation` reused for bill settlement. Posting: payment →
  `account_transaction(debit, vendor_payment)` + reduce `supplier_outstanding`. Signature via the
  existing files/attachments pipeline (`supportsAttachments`) — net-new vs reference.
- **Mobile:** vendor → bill → enter payment → select account → capture signature (upload) → Pay.
  Vendor detail → payable.
- **Exit:** vendor payment posts cash-out with signature attached; payable drops; allocated to the
  bill.

### Phase 5 — Orders
**Goal:** F8 + D11.
- **Backend:** tables `order`, `order_item`; status `pending·accepted·rejected·fulfilled`
  (append-only transitions). Accept → creates a linked `sale` via `order.linked_sale_fk`
  (convert-by-link). RBAC for `Order`.
- **Mobile:** credit customer places order → pending queue. Staff accept/reject. Accept → Sale (F2),
  on credit (F3) or settle on pickup.
- **Exit:** order placed → appears pending → staff accepts → linked sale created → optionally on
  credit.

### Sequencing
**0 → 1** first (foundations + the whole account view). Then **2** (revenue), **3** (credit +
settlement), **4** (vendor), **5** (orders). **F7** rides alongside 1–2 (counts need `shift_session`
early).

### Later (watch-list)
- Balance **checkpoints / carry-forward** per account and per customer/supplier statement period —
  kills the unbounded `Σ` scan as row counts grow (the reference's O(n)-per-posting mistake, §10).
- Server **nightly reconciliation** (companion §15G) extended across account / customer / supplier
  ledgers.
- **Full-GL upgrade (D9):** add an Income/Tax/AR posting service over the *same* events if P&L/tax
  reporting is ever needed — see §10.
- Full blind-close **X / Z reports** and the complete shift ceremony.

---

## 8. Known failure modes & guardrails

| Failure mode | Guardrail |
|--------------|-----------|
| Client mints cash (fake `credit_payment`) | Client never authors postings; server derives from events (D1). |
| Cash recorded with no sale (torn state) | Posting derived in the **same server tx** as the sale (F2.3). |
| Offline credit-limit breach (concurrent sales) | Accept + server flag/alert; limit is advisory offline (D6). |
| Balance-on-read scan grows unbounded | Balance checkpoints / carry-forward (watch-list). |
| Per-row running balance ill-defined across devices | Show total balance, not per-row running balance (§5). |
| Deleting an account that has history | Archive-only; never hard-delete a book with rows (system Cash/Bank already locked). |
| Lost/duplicated event on sync | Idempotent by `guuid`; `seq` gap detection in reconciliation. |
| Projection drift on a device | Rebuild projection from events (D7). |

---

## 9. Open questions

1. **Single- vs multi-device per store** — assumed multi (D8). If single-device-per-register, the
   offline credit-limit race (D6) softens.
2. **`account_transaction` stored projection vs pure query** — assumed stored + rebuildable (D7).
3. **Where the "sale → postings" expander runs** — new posting service in Phase 0/2 (no equivalent
   exists today).
4. **Direction convention Credit = IN** (D2) — confirm; trivial but everything signs off it.
5. **Cash-book vs full double-entry (D9)** — confirm cash-book now; the full-GL model exists in the
   reference (§10) if P&L/tax reporting is required from day one.

---

## 10. Reference cross-check — `ayphen-3.0`

Source: `/Users/saran/Downloads/ayphen-3.0/src/main/java/com/ayphen/api` — a **full online
double-entry accounting ERP** (Spring Boot, multi-tenant, multi-currency). It has **no sync engine
and no offline layer**. Every money event there is one `Transaction` row distinguished by a
`transaction_detail_fk` code (`TDSAL`, `TDSR`, `TDINVPAY`, `TDRFNDINV`, `TDDEP`, `TDSO`, `TDPO`,
`TDPUR`, `TDBILLPAY`…), posting to `journals` + `general_ledger` via a Strategy→Factory pattern.
It **independently validates** this doc's core decisions; the divergences are noted below.

### 10.1 Concept mapping (this doc ↔ reference)

| This doc | Reference: table / columns / API / logic | Verdict |
|---|---|---|
| Payment account (cash/bank) | `Account` (`account`) + `AccountCodes.code` = `CAS`/`BNK`/`CAB` — kind is **data-driven by code**, not an enum. `AccountsController /coa/accounts`. `AccountType.balance_type` = DEBIT/CREDIT gives the normal side. | ✅ Our `paymentAccounts.kind` + `systemKey` is a simpler equivalent — fine for POS. |
| `account_transaction` / balance | Balances **not stored** on `Account`; derived from `general_ledger` (materialized running closing + live `SUM` in `GeneralLedgerRepository`). | ✅✅ Validates D1/D7 (events truth, balance derived). |
| Opening balance (F1) | `Transaction.is_ob=true`, posted as journals against an `OBA` contra account. `OptimizedOpeningBalanceServiceImpl`. | ✅ Aligned; reference is double-sided (contra), we post single-sided (cash-book, D9). |
| Sale → posting (F2) | `SalesJournal` (`JRINVTDSAL`): **DR Accounts Receivable, CR Income, CR Output Tax, DR Discount**; cash sale `SalesReceiptJournal` adds **DR cash/bank**. Server-side on `open`. | ✅ Validates the posting service (D1). ⚠️ Reference posts income+tax+AR; we post **cash-in only** (D9 divergence). |
| Split tender | `TransactionPaymentDetails` (`transaction_payment_details`): one row per `account_fk` + `amount_*`. | ✅✅ Validates one-posting-per-`sale_payment`. |
| Refund (F3) | `RefundInvJournal` (`JRTRXTDRFNDINV`): inverted contra; consumes `UNEARNED_REVENUE` before AR; linked via `TransactionLink`. | ✅ Aligned. |
| Manual cash in/out (F4) | No drawer entity — `Transaction` rows `TDDEP`/`TDOWNC`/`TDTRNSR`/`TDMADJ`, `reason_fk`→Lookup. | ⚠️ Reference has **no drawer/till**; our `cash_movement` is a POS addition. |
| Customer credit + outstanding (F5) | `Customer.credit_limit`, `override` stored; receivable **derived** in `CustomerMapper` (`totalReceivable = debit − credit` over AR journals). | ✅ Validates "derive outstanding." ❌ Credit limit **stored but never enforced** (`SalesSettings.creditLimitAction` unused). |
| Customer/vendor settlement | `PaymentTransactionHeader.account_fk` + `TransactionLink` (`INV_PAY`/`BILL_PAY`) + `AppliedCredits.credits` → **invoice-level allocation**. `POST /credit-apply`, `/apply-credits`. | ⚠️ We borrow this as `payment_allocation` (D10). |
| Vendor bill + payment (F6) | Bill = `Transaction TDPUR` + `PurchaseTransactionHeader`; payment = `TDBILLPAY` + `PaymentTransactionHeader` + `TransactionLink BILL_PAY`. Supplier has **no** credit-limit column. | ✅ Aligned. |
| Vendor signature (F6) | **ABSENT** — "signature" = only JWT/Stripe/S3. Only generic `Files` via `Transaction.attachment_fk`. | ✅ Confirms signature is net-new; reuse attachments. |
| Orders (F8) | `Transaction TDSO/TDPO`; status `PENDING/APPROVED/ACCEPTED/REJECTED/RFI/…`; `PUT /{id}/sales-order/status?action=APRV\|REJ`; convert by `TransactionLink` (`PO_SO`,`EST_INV`), **not mutation**; separate Approval module. | ✅✅ Validates D11 (status + accept + convert-by-link). |
| Shift / count / variance (F7) | **ABSENT** — no shift/drawer/denomination entity. | Net-new (from `shifts-and-cash-management.md`). |
| Numbering | `TransactionNumber` (`transaction_number_sequence`) + `TransactionPrefix`. | Maps to existing `stores.invoicePrefix`/`invoiceCounter`. |

### 10.2 The three divergences that matter
1. **Full GL vs cash-book (D9).** Reference posts every sale to Income + Output-Tax + AR (real
   P&L/balance-sheet). We post **cash-in only** — a cash-book, not accounting. Fine for the stated
   requirement ("click Cash → cash in/out"); if P&L/tax/COGS reporting is ever needed, add the
   income/tax postings the reference already models, over the **same** events. Upgrade path, not a
   rewrite.
2. **Payment allocation (D10).** Reference matches a payment to specific invoices; borrowed as
   `payment_allocation` so we can answer "which bill did this pay."
3. **Enforcement + shift + signature are reference gaps.** The reference stores a credit limit but
   never checks it, has no drawer/shift, and no signature capture. Our D6 (advisory + server flag),
   F7 (shift-anchored variance), and F6 (signature) are all net-new and cannot be copied — they do
   not exist there.

### 10.3 One thing NOT to copy
`RunningBalanceService.updateRunningBalanceForLedger(companyId)` **recomputes the entire company's
ledger on every posting** (O(n), with debug `println`s and a hardcoded `account.getId()==226` branch
still in it). This is exactly the unbounded-scan failure this doc flags — the **checkpoint /
carry-forward** in §7's watch-list is the fix. Do not inherit their approach.