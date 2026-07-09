# QA Test-Case Set — Subscription & Payment Module

**Scope:** `apps/backend/src/subscription/**` (service, repository, billing, cron, downgrade-detection,
reconciliation, payment providers, DTOs, mapper, controllers) plus the two files it is inseparable
from at runtime: `apps/backend/src/auth/mobile/guards/subscription-status.guard.ts` (the write-gate
every mutating store-scoped request passes through) and `apps/backend/src/common/rbac/guards/step-up-auth.guard.ts`
(billing step-up). Money and billing correctness is **Critical** territory throughout this document.

Generated per `/docs/agent/CLAUDE-ba-qa-testcases.md`. QA mode — every rule below is read from the
actual implementation, not the PRD's aspirational description (`docs/backend/subscription.md`,
`docs/prd/subscription.md`). Where the two disagree, both are stated and the gap is called out
explicitly (§7 Open Questions) — **do not assume the PRD is what shipped.**

---

## 1. Feature Understanding (BA)

### What it does

One `account_subscriptions` row per account (`UNIQUE(account_fk)`) drives whether every store under
that account may **write** (reads are never gated). The module has five moving parts:

1. **`SubscriptionService`** — the single funnel for every state transition (`activateFromPayment`,
   `cancel`, `reactivate`). Every transition = one UPDATE (+version bump) + one outbox row, in one
   transaction, then a post-commit Redis cache invalidation.
2. **`BillingService`** — Razorpay/Fake checkout → verify → webhook orchestration. Idempotent by
   construction: `processed_payment_events(provider_ref PK)` claimed in the *same* transaction as the
   activation UPDATE.
3. **`SubscriptionLifecycleCronService`** — every 5 min: sweeps `trialing→expired`,
   `active→past_due` (grace opens), `past_due→expired` (grace closes), `active(cancel_at_period_end)
   →cancelled`. Each sweep is a bounded (500-row), atomic, idempotent `UPDATE…WHERE`, looped until a
   short batch. A second cron drains `subscription_audit_outbox` into `audit_logs`.
4. **`DowngradeDetectionService` + `ReconciliationService`** — after any plan change, checks whether
   the account now exceeds the new plan's `max_stores` / `max_devices_per_store`. If so, the account
   is frozen (`reconciliation_status='pending'`, every write blocked) until the owner explicitly
   chooses what to keep — lock/revoke only, **nothing is ever deleted**, and re-upgrading restores
   everything exactly.
5. **`SubscriptionStatusGuard`** — the actual write-gate. Runs on every store-scoped mutating route
   (`stores`, `sync`, `devices`, `invitations`, `roles`, `lookup`), reads a versioned Redis snapshot
   (`sub:{accountId}:v{n}`, 5 min TTL), and throws 402/403 by a fixed priority order (§4 BR-S22).

### Actors

- **Account owner** (`accounts.owner_user_fk`) — the *only* actor who can checkout, verify, cancel,
  reactivate, or resolve a downgrade. **Important:** despite the PRD (§9/§16/§24) describing
  `co_owner`/`accountant` as also able to bill, the actual code (`requireOwnedAccount` in
  `subscription.service.ts`, `billing.service.ts`, `reconciliation.service.ts`) checks only
  `accounts.owner_user_fk === userId` — a single-column FK, not `account_users.role`. See Open
  Question OQ-2.
- **Razorpay** (or the deterministic `FakePaymentProvider` when no live keys are configured) — the
  payment gateway, reached via checkout order-create and the `payment.captured`/`payment.failed`
  webhook.
- **The lifecycle cron** — a system actor with no HTTP identity; every transition it makes must be
  idempotent since it can double-run (Redis lock is best-effort, not a correctness guarantee — the
  DB-level `WHERE` predicate is).
- **Any authenticated device/user under the account** — reads `GET /me/subscription`,
  `GET /me/subscription/sv`, and is subject to the write-gate on every mutating request regardless of
  role.

### Inputs / Outputs

- Inputs: `plan_code` (checkout), Razorpay `order_id`/`payment_id`/`signature` (verify), raw webhook
  body + `X-Razorpay-Signature` header, `keep_store_ids`/`keep_device_ids` (reconciliation resolve),
  `activate_store_id`/`deactivate_store_id`/`keep_device_ids` (active-store swap).
- Outputs: `GET /me/subscription` (full view), `GET /me/subscription/sv` (bare version counter),
  `GET /me/subscription/plans` (catalog), `X-Subscription-Version` + `X-Subscription-Warning`
  response headers on every request that passes through `SubscriptionStatusGuard`.

### Business rules / invariants extracted from code (not the PRD)

| ID | Rule | Source |
|---|---|---|
| BR-S1 | One `account_subscriptions` row per account (`UNIQUE(account_fk)`). | schema.ts:481 |
| BR-S2 | Status enum is exactly `trialing, active, past_due, paused, cancelled, expired` — **there is no `free` status** in this table, contradicting PRD BR-026 ("no row → fallback to free"). | schema.ts:431-440 |
| BR-S3 | Grace = 7 days (`GRACE_DAYS`), only from `active→past_due`. | subscription-lifecycle-cron.service.ts:31 |
| BR-S4 | Billing period = 30 days monthly / 365 days annual, keyed by `planCode`'s billing cycle, **not** `planFk` — an annual purchase sharing a `planFk` with its monthly sibling must not lapse at 30 days. | subscription.service.ts:22-24, 182-186 |
| BR-S5 | Payment activation is idempotent by a DB-level claim: `processed_payment_events(provider_ref PK)` inserted `ON CONFLICT DO NOTHING` in the **same transaction** as the activation UPDATE. A losing claim is a silent no-op — no second version bump, no second outbox row. | subscription.service.ts:174-223, subscription.repository.ts:222-234 |
| BR-S6 | Checkout order id is durable in `payment_orders` (PK `order_id`, `onConflictDoNothing`) in addition to a 1h Redis TTL key — a webhook arriving after the Redis key expires still has data to activate against. | billing.service.ts:83-92, subscription.repository.ts:250-261 |
| BR-S7 | `verify()` binds the order to the caller: `pending.accountId !== accountId` → 404 (not 403 — doesn't reveal the order exists). | billing.service.ts:101-106 |
| BR-S8 | A webhook-reported captured amount **must** exactly match `resolvePlanPrice(planCode).amount` (and currency, case-insensitive) or the whole activation is rejected 422 `PAYMENT_AMOUNT_MISMATCH` **before** the provider-ref claim is made — so a corrected retry with the right amount can still succeed later. | billing.service.ts:156-179 |
| BR-S9 | `cancel()` requires `status==='active'`; a second cancel while already `cancelAtPeriodEnd=true` is a no-op (no second version bump). | subscription.service.ts:231-243 |
| BR-S10 | `reactivate()` (undo-cancel path) requires `status==='active'`; any lapsed status → 422 `SUBSCRIPTION_LAPSED_USE_CHECKOUT` (client must re-checkout instead). A reactivate with nothing pending is a no-op. | subscription.service.ts:252-264 |
| BR-S11 | `cancel`, `reactivate`, `POST /subscription/reconciliation`, `POST /subscription/active-store` all require step-up auth within 5 minutes (`@StepUpAuth({within:'5m'})`). `checkout`/`verify` deliberately do **not**. | me-subscription.controller.ts:82-176 |
| BR-S12 | Every real transition bumps `subscription_version` by exactly 1 and writes one outbox row, atomically; cache is invalidated **post-commit**, never inside the transaction. | subscription.service.ts:301-333 |
| BR-S13 | Cron transitions run in bounded batches of 500 rows/transaction, looped to drain; each batch's `UPDATE…WHERE` predicate is repeated on the outer statement so Postgres's EvalPlanQual re-validates a row that changed between the inner SELECT and the lock — a concurrent state change is skipped, not blindly reapplied. | subscription-lifecycle-cron.service.ts:151-162, subscription.repository.ts:319-350 |
| BR-S14 | Downgrade-over-limit freezes the **entire account** (`reconciliation_status='pending'`) — every write blocked, regardless of which store/device tipped it over. | subscription.service.ts:206-209, subscription-status.guard.ts:164-166 |
| BR-S15 | Reconciliation never auto-picks; a selection that would strand the caller's *own current device* (checked across **every** slot it holds, not just the first) is rejected. | reconciliation.service.ts:500-526 |
| BR-S16 | Auto-restore on re-upgrade is all-or-nothing and exact: unlocks every store locked `reason='downgrade'`, restores every device revoked `reason='plan_downgrade'` — skipping a device that already reclaimed a fresh slot elsewhere. | reconciliation.service.ts:258-272 |
| BR-S17 | `max_products` is **deliberately never checked** by downgrade detection (would permanently freeze an account with no way to resolve it, since there's no product-selection UI). Only `max_stores` and `max_devices_per_store` gate reconciliation. | downgrade-detection.service.ts:23-31 |
| BR-S18 | Entitlement lookup: a **missing** `plan_entitlements` row = `0` (blocked); an explicit `NULL` value = unlimited. `canCreate` uses strict `<`. | entitlement.service.ts:28-59 |
| BR-S19 | Guard write-block priority (first match wins): no resolvable account → fail-safe 403 `STORE_CONTEXT_MISSING` → no subscription row → 403 `SUBSCRIPTION_NOT_FOUND` → read method or `@AllowExpiredSubscription` → pass → `status==='paused'` → 403 `subscription_suspended` → `status==='expired'` → 402 `subscription_payment_required` → `accessValidUntil < now` (soft block, status not yet flipped) → 402 (same code) → `reconciliationStatus==='pending'` → 403 `subscription_reconciliation_required` → `storeContext.isLocked` → 403 `store_locked` → else allow. | subscription-status.guard.ts:107-179 |
| BR-S20 | Wire error envelope is **flat**: `{success, statusCode, message, data, errorCode, requestId, timestamp, details?, issues?}` — there is **no** nested `error.code`/`error.message`, contradicting the PRD's documented envelope shape (§21). `errorCode` is unconditionally lower-cased by the global filter, so the PRD's "always lowercase" claim *is* true on the wire even though the in-code `ErrorCodes.*` constants and the guard's raw `HttpException` messages are SCREAMING_SNAKE. | http-exception.filter.ts (confirmed via code read) |
| BR-S21 | The webhook route is fully public (no JWT, `@SkipThrottle`), authenticated **only** by `X-Razorpay-Signature` HMAC-SHA256 over the raw body; a missing raw body or non-string signature header is rejected before the provider is even asked to verify. | razorpay-webhook.controller.ts |
| BR-S22 | There is **no real Razorpay recurring-subscription object** — `razorpaySubId` is declared in the schema and the repo's `applyTransition` patch type, but is never written by any code path in this module. "Auto-renewal" therefore only happens if a fresh checkout+verify (or a webhook against a fresh order) lands at/before period end; otherwise the cron's default outcome at `current_period_end` is `active→past_due`, by design (code comment: "this codebase has no recurring-charge webhook yet, so period-end itself is the failure signal"). | subscription.repository.ts:363-375 comment, grep confirms no writer |
| BR-S23 | `computeBanner()` only special-cases `status==='trialing'` and `status==='expired'`; **every other status** (`active`, `past_due`, `cancelled`, `paused`) falls through to `{bannerSeverity:'none', showUpgradeBanner:false}` — see Open Question OQ-1, this is the single highest-value finding in this document. | subscription.service.ts:336-357 |

### Acceptance criteria (inferred)

- No payment retry, webhook redelivery, or double-tap can ever double-activate/double-charge/double-advance a period.
- A lapsed subscription blocks writes but never reads; nothing is ever deleted by a plan change.
- Every version bump is observable via `X-Subscription-Version`/`GET /me/subscription/sv` within one cache-TTL window (≤5 min).
- Downgrade over-limit is always resolvable by the owner and always fully reversible on upgrade.

### Ambiguities flagged (assumptions each affected case states explicitly)

- **A1:** Assume the PRD's `free` status / no-row-fallback (BR-026) is stale documentation and the
  code's behavior (403 `SUBSCRIPTION_NOT_FOUND` on a missing row) is the intended, current contract.
  Cases SUB-GUARD-010/011 test both readings.
- **A2:** Assume the code's owner-only billing gate (not `co_owner`/`accountant`) is the intended,
  current contract over the PRD's RBAC table. Cases SUB-RBAC-* test the code's actual behavior and
  flag the PRD conflict.
- **A3:** Assume `computeBanner()`'s silence on `past_due`/`cancelled`/`paused` is an unintended gap
  (not a deliberate design choice) given how explicitly the PRD documents banner text for exactly
  these states. Treated as Critical below; product should confirm.

---

## 2. Coverage Plan

| Dimension | Applies? | Approx. cases |
|---|---|---|
| Happy paths | Yes | 14 |
| Business rules (satisfied + violated) | Yes | 30 |
| Boundaries | Yes | 16 |
| Negative / invalid | Yes | 18 |
| Failure & recovery | Yes — money-critical | 16 |
| Concurrency | Yes — money-critical | 14 |
| Permissions / roles | Yes | 8 |
| State transitions | Yes — full lifecycle state machine | 20 |
| Cross-cutting (offline/sync, tenancy, time/timezone, freshness) | Yes | 14 |
| UX / experience | Partial (backend-only module; covered as response-shape/banner cases) | 6 |

Total: **~156 cases** across all dimensions (§3 + §4).

---

## 3. Test Cases

### 3.1 Plan Catalog — `GET /me/subscription/plans`

**SUB-CAT-001 — Happy: catalog returns all active plans sorted by display order**
Area: happy · Criticality: Medium · Traces to: `subscription.service.ts:getPlanCatalog`
Preconditions: `plans` seeded with `free`(order 0), `starter`(order 1), `growth`(order 2), all `is_active=true`.
Input: none (unauthenticated-but-JWT'd GET).
Steps: 1) Call `GET /me/subscription/plans`.
Expected: 200; array of 3 entries ordered `free, starter, growth`; `free.pricing = []`; `starter.pricing` has `starter_monthly` + `starter_annual`; `growth.pricing` has `growth_monthly` + `growth_annual`.
Notes: verify server-side.

**SUB-CAT-002 — Rule: annual savings_percentage computed off live monthly price, not hardcoded**
Area: rule · Criticality: Medium · Traces to: `PLAN_PRICING`, `getPlanCatalog` savings calc.
Preconditions: `starter_monthly=49900`, `starter_annual=499900` paise (seeded values).
Steps: 1) `GET /me/subscription/plans`.
Expected: `starter.pricing[annual].savings_percentage === Math.round(((49900*12-499900)/(49900*12))*100)` = 17 (not a hand-entered constant); `starter.pricing[monthly].savings_percentage === 0`.

**SUB-CAT-003 — Boundary: an inactive plan is excluded entirely**
Area: boundary · Criticality: Low · Traces to: `findActivePlansWithEntitlementsAndFeatures` filters `isActive=true`.
Preconditions: a `legacy` plan row exists with `is_active=false`.
Steps: 1) `GET /me/subscription/plans`.
Expected: `legacy` never appears in the response, even if it has entitlement/feature rows.

**SUB-CAT-004 — Edge: a plan with zero `PLAN_PRICING` entries (unseeded/renamed plan) returns an empty pricing array, not an error**
Area: edge · Criticality: Medium · Traces to: `getPlanCatalog` filter on `price.planName === plan.name`.
Preconditions: a new `plans` row `enterprise` seeded, but `PLAN_PRICING` has no `enterprise_*` keys yet.
Steps: 1) `GET /me/subscription/plans`.
Expected: `enterprise` entry present with `pricing: []`, `entitlements`/`features` populated from its own rows, `display_order: 99` (default meta) unless `PLAN_META['enterprise']` was added.
Notes: this is exactly the doc/seed drift the code comment on `plan-pricing.ts` calls out — a plan can exist and not be purchasable.

**SUB-CAT-005 — Negative: `feature_labels` omits a key seeded for a plan but never listed in `FEATURE_LABELS`**
Area: negative · Criticality: Low · Traces to: `plan-meta.ts:FEATURE_LABELS` vs `seed.ts` plan feature keys.
Preconditions: current seed only sets `barcode_scanning`/`advanced_reports`/`offline_mode` per plan; `FEATURE_LABELS` additionally lists an unused `multi_store` key that no plan ever has.
Steps: 1) `GET /me/subscription/plans`; inspect `feature_labels` vs each plan's `features` map keys.
Expected: every key present in any plan's `features` object has a matching `feature_labels` entry (true today); `multi_store` is a dead label with no matching feature anywhere — flag as a Low finding, not a functional break.

---

### 3.2 Subscription Read Model — `GET /me/subscription`, `GET /me/subscription/sv`

**SUB-VIEW-001 — Happy: active paid account, full view shape**
Area: happy · Criticality: High · Traces to: `getViewForUser`, `SubscriptionResponseMapper.toResponse`.
Preconditions: account subscription `status=active`, `planCode=starter_monthly`, `currentPeriodEnd` = now+20d.
Steps: 1) `GET /me/subscription` as the account owner.
Expected: 200; `status:"active"`, `billing_cycle:"monthly"`, `plan.price:{amount:49900,currency:"INR"}`, `banner_severity:"none"`, `show_upgrade_banner:false`, `reconciliation_status:"none"`.

**SUB-VIEW-002 — Boundary: pre-checkout account (no `planCode` set yet, on `free`/trial default) — `price` is null**
Area: boundary · Criticality: Medium · Traces to: `getViewForUser` — `billingPlanCode ? resolvePlanPrice(...) : null`.
Preconditions: fresh trialing subscription, `plan_code` column `NULL`.
Steps: 1) `GET /me/subscription`.
Expected: `plan.billing_cycle: null`, `plan.price: null` — no crash on a null lookup key.

**SUB-VIEW-003 — Negative: member (non-owner) with no `account_users` membership requests the view**
Area: negative · Criticality: High · Traces to: `findMemberAccountId`.
Preconditions: `userId` has no `account_users` row anywhere.
Steps: 1) `GET /me/subscription`.
Expected: 404 `subscription_not_found` (via `getViewForUser` returning `null` → controller throws `NotFoundError`). No account/plan data ever leaks for a user who belongs to no account.

**SUB-VIEW-004 — Happy: cheap version-poll endpoint returns just the counter**
Area: happy · Criticality: Medium · Traces to: `getVersionForUser`.
Steps: 1) `GET /me/subscription/sv`.
Expected: `{subscription_version: <n>}` only — no plan/entitlement join executed (verify via query plan/log if feasible, otherwise verify response shape has no other keys).

**SUB-VIEW-005 — Rule violated: `computeBanner` produces no banner for a `past_due` (in-grace) subscription — CRITICAL gap**
Area: rule (violated) · Criticality: **Critical** · Traces to: BR-S23; PRD §22 explicitly requires a warning/critical banner here.
Preconditions: subscription `status='past_due'`, `pastDueGraceUntil` = now+5d (day-2 of grace).
Steps: 1) `GET /me/subscription` directly (not through a store-scoped route, so `SubscriptionStatusGuard`'s `X-Subscription-Warning` header never fires either — this controller has no `SubscriptionStatusGuard`).
Expected (per code, as shipped): `banner_severity:"none"`, `show_upgrade_banner:false` — the owner opens the subscription screen and sees **no warning at all** that their card was declined and they have days left before write-lock. This directly contradicts PRD §22 ("Payment failed — X days to renew"). File as a defect; see OQ-1.

**SUB-VIEW-006 — Rule violated: same gap for `cancelled` (pending, before period end)**
Area: rule (violated) · Criticality: **Critical** · Traces to: BR-S23.
Preconditions: `status='active'`? — no: `cancel()` keeps `status='active'` with `cancelAtPeriodEnd=true` until period end (BR-S9's companion transition), so this specific case is actually **covered** by the `active` default branch too → still `none`/`false`. Confirm: PRD §12 wants "Access ends {date} — reactivate anytime" info banner during this window; code never shows it regardless of `cancelAtPeriodEnd`. `cancel_at_period_end` is exposed as a raw boolean in the payload, so a *client* could build this banner itself from that field — but `banner_severity`/`show_upgrade_banner` (the fields the PRD says the server computes) do not reflect it.
Steps: 1) `cancel()` an active subscription. 2) `GET /me/subscription`.
Expected (as shipped): `status:"active"`, `cancel_at_period_end:true`, `banner_severity:"none"`. Client must derive its own banner from `cancel_at_period_end` — confirm this is the intended contract (OQ-1).

**SUB-VIEW-007 — Rule violated: same gap for `paused` (admin suspension) — should be critical/blocking, shows none**
Area: rule (violated) · Criticality: **Critical** · Traces to: BR-S23.
Preconditions: `status='paused'`.
Steps: 1) `GET /me/subscription`.
Expected (as shipped): `banner_severity:"none"` even though every write is already 403-blocked. An owner checking their subscription screen sees no explanation for why the app suddenly stopped letting them sell.

**SUB-VIEW-008 — Rule satisfied: `expired` status (trial ended or grace ended) does show a critical banner**
Area: rule · Criticality: High · Traces to: `computeBanner` `case 'expired'`.
Preconditions: `status='expired'`.
Steps: 1) `GET /me/subscription`.
Expected: `banner_severity:"critical"`, `show_upgrade_banner:true`. (This is the one lapsed-state the code does handle — contrast with SUB-VIEW-005/006/007.)

**SUB-VIEW-009 — Boundary: trialing banner severity thresholds (4d / 3d / 1d / 0d-negative)**
Area: boundary · Criticality: High · Traces to: `computeBanner` trialing branch, `Math.ceil`.
Preconditions/Steps (4 sub-cases, `trialEndsAt` set to now+4d1h, now+3d, now+1d, now-1h respectively):
Expected: now+4d1h → `left=5`→`info`; now+3d exactly → `left=3`→`warning` (boundary: `<=3`); now+1d → `left=1`→`critical` (boundary `<=1`); now-1h (cron hasn't flipped status yet) → `left<=0`→`critical`. All four → `show_upgrade_banner:true`.
Notes: exercise the exact `Math.ceil` boundary at `left===3` and `left===1` — off-by-one is the classic bug here (`<` vs `<=`).

---

### 3.3 Checkout — `POST /me/account/subscription/checkout`

**SUB-CO-001 — Happy: owner checks out for `starter_monthly`**
Area: happy · Criticality: Critical · Traces to: `BillingService.checkout`.
Preconditions: caller is `accounts.owner_user_fk`; `starter_monthly` resolves via `PLAN_PRICING`; `plans.starter` exists.
Input: `{plan_code:"starter_monthly"}`.
Steps: 1) POST checkout.
Expected: 200; `{provider, key, order_id, amount:49900, currency:"INR", prefill:{name,contact}}`; a `payment_orders` row exists keyed by the returned `order_id`; Redis `pay:order:{order_id}` set with 1h TTL.

**SUB-CO-002 — Negative: unknown plan code**
Area: negative · Criticality: High · Traces to: `resolvePlanPrice` returns null.
Input: `{plan_code:"ultra_platinum_monthly"}`.
Expected: 422 `unknown_plan_code`. No order created, no Razorpay call made.

**SUB-CO-003 — Boundary: plan code case-sensitivity**
Area: boundary · Criticality: Medium · Traces to: `PLAN_PRICING` is a plain object keyed by exact string.
Input: `{plan_code:"Starter_Monthly"}` (wrong case).
Expected: 422 `unknown_plan_code` — no case-insensitive fallback.

**SUB-CO-004 — Negative: plan resolves in `PLAN_PRICING` but has no matching `plans` row (seed drift)**
Area: negative · Criticality: High · Traces to: `findPlanIdByName` returns null → `PLAN_NOT_CONFIGURED`.
Preconditions: `PLAN_PRICING` extended with a `pro_monthly` entry pointing at `planName:'pro'`, but no `plans` row named `pro` exists yet.
Expected: 422 `plan_not_configured`. Documents the exact seed/pricing-map coupling called out in `plan-pricing.ts`'s own comment.

**SUB-CO-005 — Negative: non-owner (a `manager`/`cashier`/`co_owner`-equivalent account member) attempts checkout**
Area: negative/permission · Criticality: **Critical** · Traces to: BR-S13 (OQ-2), `requireOwnedAccount`.
Preconditions: caller belongs to the account via `account_users` with some role, but is **not** `accounts.owner_user_fk`.
Expected (as shipped): 403 `not_account_owner` — even if that member's role is conceptually `co_owner`/`accountant`, since the code checks only the single owner FK. If product intends co-owners to bill (per PRD §9/§16), this is a functional gap, not a security bug — flag via OQ-2.

**SUB-CO-006 — Failure: payment provider order-create throws (gateway down/timeout)**
Area: failure · Criticality: **Critical** · Traces to: `BillingService.createOrder` catch → 503; `RazorpayPaymentProvider.postOrder` retry/timeout logic.
Preconditions: Razorpay bound provider; simulate 3 consecutive 5xx or a hung socket past 8s.
Expected: after 3 attempts (only 5xx/network errors retried, not 4xx) → 503 `payment_provider_unavailable`. No `payment_orders` row is created (the DB insert happens only after `createOrder` returns successfully). No Redis key set.

**SUB-CO-007 — Failure: Razorpay 4xx (bad request) is not retried**
Area: failure · Criticality: Medium · Traces to: `postOrder` — "Retry only transient server-side failures; 4xx is a real error, return it."
Preconditions: Razorpay returns 400 (e.g., malformed amount).
Expected: immediate 503 `payment_provider_unavailable` surfaced to the client (the raw 4xx detail is swallowed server-side, only logged) — **only 1 attempt made**, not 3. Verify via call count if instrumented.

**SUB-CO-008 — Failure / resilience gap: Redis is unreachable when the order key is written — UNCAUGHT, whole checkout fails**
Area: failure · Criticality: **High** (resilience gap) · Traces to: `checkout()` — `await this.redis.set(orderKey(...), ...)` is **not** wrapped in try/catch, unlike every other Redis write/delete in this module (`invalidateCache`, `applySuccess`'s `redis.del`, both explicitly best-effort).
Preconditions: durable order-create + `insertPaymentOrder` already committed; Redis connection then throws on the following `set`.
Steps: 1) trigger checkout with Redis down/erroring.
Expected (as shipped): the whole `checkout()` call throws → client gets a 500 (uncaught) even though a valid `payment_orders` row now exists and a later webhook could still activate against it. The client never receives the Razorpay `clientPayload`, so no money is at risk, but the checkout experience fails needlessly on a cache blip that every other write path in this file treats as best-effort. Recommend wrapping in try/catch to match the module's own established pattern.

**SUB-CO-009 — Concurrency: rapid double-tap on "Upgrade" for the *same* plan (idempotency key collision)**
Area: concurrency · Criticality: High · Traces to: `idempotencyKey: '${accountId}:${planCode}'`; `FakePaymentProvider.createOrder` derives `orderId` deterministically from it; `insertPaymentOrder`'s `onConflictDoNothing`.
Preconditions: FakePaymentProvider bound (dev/test); two checkout calls fire within milliseconds for the same account+plan_code.
Steps: 1) Fire two concurrent `POST checkout` calls with identical `plan_code`.
Expected: both calls return the **same** `order_id` (deterministic under Fake); the second `insertPaymentOrder` call is a clean no-op (PK conflict); no duplicate row, no error surfaced to the client, no double order.

**SUB-CO-010 — Concurrency (Razorpay-specific): same double-tap against the real provider produces two distinct orders**
Area: concurrency · Criticality: Medium · Traces to: `RazorpayPaymentProvider.createOrder` always calls the live API; Razorpay does not dedupe by `receipt` server-side by default.
Expected: two different `order_id`s, two `payment_orders` rows for the same account+plan. Not a double-charge (user only pays one), but is a data-hygiene / UX gap — the abandoned order lingers until its 1h Redis TTL and forever in `payment_orders` (no cleanup job observed in this module). Flag as Medium.

**SUB-CO-011 — Cross-cutting: prefill uses `users.name`/`users.phone`, never the account's internal display label**
Area: rule · Criticality: Medium · Traces to: BR-028 (PRD), `findBillingPrefill`.
Preconditions: `accounts.name = "Raj Kumar's Business"`, `users.name = "Raj Kumar"`, `users.phone = "+919876543210"`.
Expected: `prefill = {name:"Raj Kumar", contact:"+919876543210"}` — never the account label.

**SUB-CO-012 — Boundary: `plan_code` at max DTO length (60 chars) and empty string**
Area: boundary · Criticality: Low · Traces to: `CheckoutDtoSchema` `z.string().min(1).max(60)`.
Input: `{plan_code:""}` and `{plan_code:"a".repeat(61)}`.
Expected: both rejected 422 at DTO-validation layer before reaching `BillingService` (empty fails `.min(1)`, 61-char fails `.max(60)`).

---

### 3.4 Verify — `POST /me/account/subscription/verify`

**SUB-VF-001 — Happy: valid signature activates the subscription**
Area: happy · Criticality: Critical · Traces to: `BillingService.verify` → `applySuccess` → `activateFromPayment`.
Preconditions: a pending order exists for this account; caller computes a correct HMAC signature (Fake provider: `sign('${orderId}|${paymentId}')`).
Steps: 1) POST verify with matching `order_id`/`payment_id`/valid `signature`.
Expected: 200 `{activated:true}`; `account_subscriptions.status='active'`, `currentPeriodStart=now`, `currentPeriodEnd=now+30d` (monthly) or `+365d` (annual, keyed by `planCode`), `subscription_version` incremented by 1; one `SUBSCRIPTION_ACTIVATED` outbox row; Redis version pointer deleted.

**SUB-VF-002 — Negative: invalid signature**
Area: negative · Criticality: Critical · Traces to: `payments.verifyPayment` returns `ok:false`.
Input: tampered `signature`.
Expected: 403 `payment_signature_invalid`. No state change; `processed_payment_events` untouched (claim never attempted — the signature check happens before `applySuccess`).

**SUB-VF-003 — Negative: order not found (garbage `order_id`)**
Area: negative · Criticality: High · Traces to: `readOrder` returns null.
Expected: 404 `payment_order_not_found`.

**SUB-VF-004 — Negative / security: cross-account order hijack**
Area: negative · Criticality: **Critical** · Traces to: BR-S7 — `pending.accountId !== accountId`.
Preconditions: account B's owner obtains account A's real `order_id`/`payment_id`/valid `signature` (e.g., leaked via logs/network capture) and calls verify as account B's owner.
Steps: 1) Account B owner POSTs verify with A's order/payment/signature.
Expected: 404 `payment_order_not_found` (not 403) — the order-not-found response is indistinguishable from a genuinely unknown order, so account B cannot even confirm account A's order exists. Account A's subscription is **not** activated by B's call, and B's own subscription is untouched.

**SUB-VF-005 — Concurrency / idempotency: verify called twice for the same payment (client retry after a timeout)**
Area: concurrency · Criticality: **Critical** · Traces to: BR-S5.
Preconditions: first verify call already committed activation and deleted the Redis order key.
Steps: 1) Client, having not received the first response (network blip), retries the identical verify call.
Expected: second call's `readOrder` falls back to the durable `payment_orders` row (Redis key gone) → finds it → re-runs `payments.verifyPayment` (still valid, deterministic) → `applySuccess` → `claimPaymentEvent` conflicts on the same `providerRef` → returns `false` → `activateFromPayment`'s claimed-guard returns `null` → **no second version bump, no second outbox row, no re-extension of `currentPeriodEnd`**. Response is still `{activated:true}` (idempotent from the client's point of view). **This is the core "no double-charge" guarantee — must pass.**

**SUB-VF-006 — Concurrency: verify and webhook race for the same payment**
Area: concurrency · Criticality: **Critical** · Traces to: BR-S5 (same `providerRef` claim guards both entry points).
Preconditions: the client's verify call and Razorpay's `payment.captured` webhook both arrive within milliseconds of each other for the same `payment_id`.
Steps: 1) Fire both concurrently (simulate with two parallel requests).
Expected: exactly one commits the activation (whichever transaction's `INSERT…ON CONFLICT` wins the row lock first); the other observes the conflict and no-ops. `subscription_version` advances by exactly 1, not 2. No double period-extension.

**SUB-VF-007 — Failure / resilience gap: Redis unreachable during verify — no DB fallback reached**
Area: failure · Criticality: **High** · Traces to: `readOrder()` calls `readTypedCache(this.redis, ...)` directly; `readTypedCache` only catches `JSON.parse`/schema failures, **not** a `redis.get` connection error — an unreachable Redis throws straight up through `readOrder`, uncaught (unlike `SubscriptionStatusGuard.loadSubscription`, which explicitly wraps its cache read in try/catch for exactly this reason).
Preconditions: Redis connection down/erroring; a valid durable `payment_orders` row exists for this order.
Steps: 1) POST verify while Redis is down.
Expected (as shipped): the call throws before ever reaching the DB fallback → 500 to a customer who has genuinely paid. The durable row was supposed to be exactly the safety net for this scenario (per `readOrder`'s own doc comment) but the uncaught `redis.get` short-circuits it. **This is the single highest-value failure-mode finding for the "payment failure/retry handling" ask** — recommend wrapping the Redis read in the same try/catch pattern the guard uses.

**SUB-VF-008 — Rule violated: amount mismatch (defence in depth) is verify-path-agnostic**
Area: rule · Criticality: High · Traces to: BR-S8. Note: `verify()` never passes a `captured` amount (only the webhook path does, since Razorpay's checkout callback doesn't report the charged amount to the client) — so this specific check is **webhook-only** in practice.
Expected (documented behavior, not a bug): a forged/tampered signature on the *client* verify path is caught by signature validation (SUB-VF-002); the amount-mismatch defence specifically protects the *webhook* path where the amount is attacker/gateway-supplied. Confirm this split is intentional — see coverage note in §5.

**SUB-VF-009 — Boundary: DTO field length limits**
Area: boundary · Criticality: Low · Traces to: `VerifyPaymentDtoSchema` — `order_id`/`payment_id` max 100, `signature` max 128.
Input: 101-char `order_id`; 129-char `signature`.
Expected: 422 validation error before reaching `BillingService`.

---

### 3.5 Webhook — `POST /webhooks/razorpay`

**SUB-WH-001 — Happy: `payment.captured` activates, matching amount**
Area: happy · Criticality: Critical · Traces to: `BillingService.dispatch`.
Preconditions: valid HMAC over raw body; `payload.payment.entity.amount` equals `resolvePlanPrice(planCode).amount`.
Expected: 200 `{handled:true}`; subscription activated exactly as SUB-VF-001.

**SUB-WH-002 — Negative: invalid webhook signature**
Area: negative · Criticality: **Critical** · Traces to: `verifyWebhook` HMAC mismatch → `ok:false`.
Expected: 403 `webhook_signature_invalid`. No state change, no claim attempted. `timingSafeEqual` used — verify no signature-length short-circuit leaks timing (already handled: length mismatch returns false immediately via `ab.length===bb.length` before the constant-time compare, which is the correct, standard pattern and not a timing leak since it's a length check not a byte-content check).

**SUB-WH-003 — Negative: missing raw body or missing/non-string signature header**
Area: negative · Criticality: High · Traces to: `RazorpayWebhookController.handle` guard clause.
Steps: 1) POST with no `X-Razorpay-Signature` header. 2) POST with the header present but body-parser's `rawBody` capture missing (e.g., wrong `Content-Type`).
Expected: 403 `webhook_signature_invalid` in both cases, before the provider's `verifyWebhook` is even called.

**SUB-WH-004 — Negative: malformed JSON body (valid signature over garbage bytes)**
Area: negative · Criticality: Medium · Traces to: `normalizeWebhook` — `JSON.parse` throws → caught → `{type:'ignored'}`.
Expected: 200 `{handled:true}` (webhook ack'd so Razorpay doesn't retry-storm), but **no** state change — this is a deliberate "ignored" event, not an error.

**SUB-WH-005 — Rule: unrecognized event type is ignored, not errored**
Area: rule · Criticality: Medium · Traces to: `normalizeWebhook` falls through to `{type:'ignored'}` for any `event` other than `payment.captured`/`payment.failed`.
Input: `event:"refund.processed"` (valid signature, well-formed body).
Expected: 200 `{handled:true}`, no state change. Confirms forward-compatibility with new Razorpay event types the code doesn't yet understand.

**SUB-WH-006 — Rule: `payment.failed` webhook causes no state change**
Area: rule · Criticality: High · Traces to: `dispatch()` — only `payment.succeeded` is handled; `payment.failed` and `ignored` are explicit no-ops "the account stays as-is and the owner can simply retry."
Preconditions: account currently `active`, mid-period.
Steps: 1) POST a well-formed `payment.failed` webhook (e.g., a failed *renewal-attempt* charge, if one were ever initiated — see BR-S22, no such automatic charge actually exists today).
Expected: subscription row completely unchanged — no `past_due` transition from this event. (The only path to `past_due` in this codebase is the lifecycle cron's period-end sweep, not a webhook.) This is an important behavioral fact to confirm with product: a failed webhook is silently swallowed with no notification path visible in this module.

**SUB-WH-007 — Rule violated: amount mismatch rejects with 422 and does not claim the provider ref**
Area: rule (violated case) · Criticality: **Critical** · Traces to: BR-S8.
Preconditions: webhook reports `amount:39900` but `resolvePlanPrice('starter_monthly').amount===49900` (dashboard/config drift, or a forged webhook attempting to under-charge-then-activate).
Steps: 1) POST webhook with mismatched amount + otherwise-valid signature.
Expected: 422 `payment_amount_mismatch`; a server-side `logger.error` line is emitted (not `warn` — alertable); subscription **not** activated; `processed_payment_events` has **no** row for this `providerRef` (claim happens only after the amount check passes) — so a corrected redelivery with the right amount can still succeed later (SUB-WH-008).

**SUB-WH-008 — Recovery: redelivery after the amount is corrected upstream succeeds**
Area: failure/recovery · Criticality: High · Traces to: BR-S8's "never poison the idempotency key" property.
Preconditions: follows directly from SUB-WH-007 — same `orderId`/`providerRef`, amount now corrected to match.
Steps: 1) Razorpay (or a manual replay) redelivers the same webhook with the corrected amount.
Expected: 200, activation proceeds normally — the earlier mismatch did not burn the `providerRef` claim.

**SUB-WH-009 — Concurrency: webhook redelivered N times after a successful activation (Razorpay's real-world at-least-once delivery)**
Area: concurrency · Criticality: **Critical** · Traces to: BR-S5.
Steps: 1) Deliver the identical `payment.captured` webhook 3 times in a row (simulating Razorpay's retry policy on a slow 200 ack).
Expected: first call activates; calls 2 and 3 each hit the `claimPaymentEvent` conflict and no-op — `subscription_version` advances by exactly 1 across all 3 deliveries, `currentPeriodEnd` set exactly once.

**SUB-WH-010 — Out-of-order: stale order's late webhook arrives after a newer order already activated a different plan**
Area: concurrency/state (out-of-order) · Criticality: **High** (open design gap) · Traces to: `activateFromPayment` has no "is this the most recent order for this account" check — it applies whatever `planFk`/`planCode` the *given* order maps to, unconditionally, as long as the `providerRef` claim succeeds.
Preconditions: 1) Owner starts checkout A for `starter_monthly`, abandons the Razorpay page without paying. 2) Owner starts checkout B for `growth_annual` shortly after, pays, verify succeeds → account is now `active`/`growth`/annual period. 3) Days later, a stale payment against order A's Razorpay order somehow completes (e.g., a saved/retried payment link) and its webhook arrives.
Steps: 1) Simulate steps above; deliver order A's `payment.captured` webhook last.
Expected (as shipped): order A's webhook has a **different, never-before-claimed** `providerRef` → the claim succeeds → `activateFromPayment` runs with order A's `starter`/`monthly` plan data → the account is silently **downgraded back to Starter monthly**, overwriting the Growth annual period the owner already paid for and is actively using. This is a genuine correctness gap with real money impact; flag prominently (OQ-5).

---

### 3.6 Cancel — `POST /me/subscription/cancel`

**SUB-CX-001 — Happy: active subscription requests cancellation**
Area: happy · Criticality: Critical · Traces to: `SubscriptionService.cancel`.
Preconditions: `status='active'`, `cancelAtPeriodEnd=false`, caller is owner, step-up done within 5 min.
Steps: 1) POST cancel.
Expected: 200; `status` stays `'active'`, `cancel_at_period_end:true`, `subscription_version+1`; one `SUBSCRIPTION_CANCEL_REQUESTED` outbox row.

**SUB-CX-002 — Rule violated: cancel a non-active subscription (trialing/past_due/cancelled/expired/paused)**
Area: rule (violated) · Criticality: High · Traces to: BR-S9.
Preconditions: 5 sub-cases, one per non-active status.
Expected: all five → 422 `subscription_not_active`. No state change in any case.

**SUB-CX-003 — Rule: idempotent double-cancel is a clean no-op**
Area: rule/concurrency · Criticality: High · Traces to: `if (current.cancelAtPeriodEnd) return null;`.
Preconditions: already `cancelAtPeriodEnd=true`.
Steps: 1) POST cancel again.
Expected: 200, same `subscription_version` (not incremented), no second outbox row, no second cache invalidation triggered by a new version (invalidation still runs once per call but on the same version — harmless).

**SUB-CX-004 — Concurrency: two simultaneous cancel requests (double-tap on "Confirm Cancel")**
Area: concurrency · Criticality: High · Traces to: transaction-scoped read-then-write inside `uow.execute`.
Steps: 1) Fire two POST cancel calls in parallel.
Expected: exactly one increments the version and writes the outbox row; the other observes `cancelAtPeriodEnd` already true within its own transaction ordering (Postgres row-level serialization on the UPDATE) and no-ops. Final state: `cancel_at_period_end:true`, version advanced by exactly 1.

**SUB-CX-005 — Permission: non-owner attempts cancel**
Area: permission · Criticality: **Critical** · Traces to: `requireOwnedAccount` (see OQ-2).
Expected: 403 `not_account_owner`, regardless of the caller's `account_users` role.

**SUB-CX-006 — Permission/negative: step-up not satisfied (never done, or done >5 min ago)**
Area: permission · Criticality: **Critical** · Traces to: `StepUpAuthGuard`, `@StepUpAuth({within:'5m'})`.
Preconditions: (a) principal has never stepped up (`stepUpAt` undefined); (b) principal stepped up 5 min 1 sec ago.
Expected: both → 403 `step_up_auth_required`, before the controller method (and thus `SubscriptionService.cancel`) is ever invoked.

**SUB-CX-007 — Boundary: step-up exactly at the 5-minute window edge**
Area: boundary · Criticality: High · Traces to: `Date.now() - stepUpAt.getTime() > withinMs`.
Preconditions: step-up occurred exactly 5:00.000 ago vs 4:59.999 ago.
Expected: 4:59.999 → allowed (not `>` the window); 5:00.000+1ms → rejected. Exercise this exact `>` (strictly-greater) boundary — the classic off-by-one for time windows.

**SUB-CX-008 — Cross-cutting: cancelling does not touch `access_valid_until` or unblock/reblock writes immediately**
Area: cross-cutting · Criticality: High · Traces to: `cancel()` only sets `cancelAtPeriodEnd`; `accessValidUntil` untouched.
Steps: 1) Cancel an active subscription with 10 days left in the period. 2) Immediately attempt a write (e.g., create a sale) as a cashier under this account.
Expected: write succeeds normally — access continues through the full paid period, exactly per PRD §12's "never cancel immediately by default."

---

### 3.7 Reactivate — `POST /me/subscription/reactivate`

**SUB-RX-001 — Happy (Case A — before period end): undo a pending cancellation**
Area: happy · Criticality: Critical · Traces to: `SubscriptionService.reactivate`.
Preconditions: `status='active'`, `cancelAtPeriodEnd=true`.
Steps: 1) POST reactivate.
Expected: 200; `cancel_at_period_end:false`, `status` stays `'active'`, version+1, no charge.

**SUB-RX-002 — Rule violated (Case B — after period end): reactivate on a lapsed subscription must fail with a specific redirect code**
Area: state · Criticality: **Critical** · Traces to: BR-S10.
Preconditions: 4 sub-cases: `status` ∈ {`past_due`, `cancelled`, `expired`, `paused`}.
Expected: all four → 422 `subscription_lapsed_use_checkout` (a distinct code from generic `subscription_not_active`, so the client knows to route to the full checkout flow rather than retry reactivate).

**SUB-RX-003 — Rule: idempotent no-op when nothing is pending**
Area: rule · Criticality: Medium · Traces to: `if (!current.cancelAtPeriodEnd) return null;`.
Preconditions: `status='active'`, `cancelAtPeriodEnd=false` (nothing to undo).
Steps: 1) POST reactivate.
Expected: 200, no version bump, no outbox row — a harmless no-op rather than an error, even though "nothing to reactivate."

**SUB-RX-004 — Permission + step-up**: identical structure to SUB-CX-005/006/007, applied to reactivate.
Area: permission · Criticality: Critical · Expected: non-owner → 403 `not_account_owner`; stale/absent step-up → 403 `step_up_auth_required`.

**SUB-RX-005 — State transition: Case B "reactivate" is actually routed through checkout, not this endpoint**
Area: state/UX · Criticality: Medium · Traces to: PRD §13 Case B vs code's `SUBSCRIPTION_LAPSED_USE_CHECKOUT`.
Expected: confirms the client contract — after a 422 here, the correct client behavior is to call `POST /me/account/subscription/checkout` + `verify`, which (per SUB-CO/SUB-VF happy paths) fully reactivates: sets `status='active'`, fresh period, `cancelAtPeriodEnd` is **not** explicitly reset to `false` by `activateFromPayment` — verify this field's value after a Case-B reactivation (see SUB-CX-009 below for the specific check).

**SUB-CX-009 — Rule: does re-checkout after a period-over cancellation clear the stale `cancel_at_period_end` flag?**
Area: rule/state · Criticality: **High** · Traces to: `activateFromPayment`'s `applyTransition` patch does **not** include `cancelAtPeriodEnd` in its set — only `status, planFk, planCode, currentPeriodStart, currentPeriodEnd, accessValidUntil`.
Preconditions: subscription previously cancelled with `cancelAtPeriodEnd=true`, now `status='cancelled'` (period over). Owner re-checks-out and pays.
Steps: 1) Complete checkout+verify while `cancelAtPeriodEnd` is still `true` from the old cancellation.
Expected (verify against actual behavior): if `cancelAtPeriodEnd` is left `true` from the prior cycle, the **very next** lifecycle cron pass will immediately re-cancel the freshly-reactivated subscription at its new `currentPeriodEnd` (since `expireCancelledAtPeriodEnd`'s predicate is exactly `status='active' AND cancelAtPeriodEnd=true AND currentPeriodEnd<now`) — this would silently auto-cancel a subscription the owner just paid for and never asked to cancel again, 30/365 days later. **This must be verified against a real run**; if `cancelAtPeriodEnd` is not reset on reactivation-via-checkout, this is a Critical latent bug. File as OQ-6 regardless of the outcome, since the fix (or the "it's already fine because X resets it elsewhere") should be traceable to a specific line.

---

### 3.8 Lifecycle Cron — `SubscriptionLifecycleCronService`

**SUB-CRON-001 — Happy/state: `trialing → expired` exactly at `trial_ends_at`**
Area: state · Criticality: Critical · Traces to: `expireTrials`.
Preconditions: `status='trialing'`, `trialEndsAt` = now−1s.
Steps: 1) Run `reconcile()`.
Expected: row transitions to `status='expired'`, version+1, one `SUBSCRIPTION_TRIAL_ENDED` outbox row, cache invalidated for that account.

**SUB-CRON-002 — Boundary: `trial_ends_at` exactly equal to `now` (not yet past) is not swept**
Area: boundary · Criticality: High · Traces to: `lt(trialEndsAt, now)` — strict less-than.
Preconditions: `trialEndsAt === now` (same instant, or now+1ms).
Expected: not transitioned this tick (predicate is `<`, not `<=`); will be swept on the very next tick once it's genuinely in the past.

**SUB-CRON-003 — Happy/state: `active → past_due` at `current_period_end`, grace window opens**
Area: state · Criticality: Critical · Traces to: `expireActiveToPastDue`.
Preconditions: `status='active'`, `cancelAtPeriodEnd=false`, `currentPeriodEnd`=now−1s.
Steps: 1) `reconcile()`.
Expected: `status='past_due'`, `pastDueGraceUntil = now+7d`, `accessValidUntil = pastDueGraceUntil` (not `currentPeriodEnd` — the guard's access check must now use the *new* window), version+1.

**SUB-CRON-004 — Rule: `active` + `cancelAtPeriodEnd=true` is excluded from the past-due sweep**
Area: rule/state · Criticality: **Critical** · Traces to: `expireActiveToPastDue`'s `WHERE cancel_at_period_end=false`; code comment: cancelled-at-period-end must never be mistaken for an unpaid-renewal failure.
Preconditions: `status='active'`, `cancelAtPeriodEnd=true`, `currentPeriodEnd`=now−1s.
Steps: 1) `reconcile()`.
Expected: this row is **not** touched by `expireActiveToPastDue` (no grace window opened) — it is instead picked up by `expireCancelledAtPeriodEnd` in the very same `reconcile()` call, transitioning straight to `status='cancelled'`. Verify both sweeps in the same tick don't double-process the same row (mutually exclusive predicates on `cancelAtPeriodEnd`).

**SUB-CRON-005 — Happy/state: `active(cancel_at_period_end=true) → cancelled` at period end**
Area: state · Criticality: Critical · Traces to: `expireCancelledAtPeriodEnd`.
Steps: 1) `reconcile()` on the precondition above.
Expected: `status='cancelled'`, version+1, `accessValidUntil` left as-is (still `currentPeriodEnd`, already in the past) — the guard's soft-block path (BR-S19) fires for writes even though `'cancelled'` is not in the guard's explicit `PAYMENT_REQUIRED_STATUSES` set.

**SUB-CRON-006 — Happy/state: `past_due → expired` when grace elapses**
Area: state · Criticality: Critical · Traces to: `expirePastDueGrace`.
Preconditions: `status='past_due'`, `pastDueGraceUntil`=now−1s.
Steps: 1) `reconcile()`.
Expected: `status='expired'`, version+1. Guard now blocks via the explicit `PAYMENT_REQUIRED_STATUSES` path (not just the soft accessValidUntil fallback).

**SUB-CRON-007 — Recovery: payment succeeds mid-grace (day 3 of 7) — full recovery, no partial state**
Area: happy/recovery · Criticality: Critical · Traces to: `activateFromPayment` overwrites `status`/`currentPeriodStart`/`currentPeriodEnd`/`accessValidUntil` unconditionally.
Preconditions: `status='past_due'`, day 3 of grace.
Steps: 1) Owner completes checkout+verify.
Expected: `status='active'`, fresh 30/365-day period from `now`, `pastDueGraceUntil` left stale (harmless — `accessValidUntil` no longer derived from it) — verify the stale `pastDueGraceUntil` value never resurfaces incorrectly in a later cron pass (it can't: `expireActiveToPastDue`'s predicate only matches `status='active' AND currentPeriodEnd<now`, and the fresh `currentPeriodEnd` is 30 days out).

**SUB-CRON-008 — Concurrency: two cron instances tick simultaneously (Redis lock)**
Area: concurrency · Criticality: **Critical** · Traces to: `RECON_LOCK` `SET NX EX 900`.
Steps: 1) Simulate two app instances' schedulers firing `reconcile()` at the same moment.
Expected: exactly one acquires the lock (`SET...NX` succeeds); the other's `set` returns null and it returns immediately without touching any row. No double-processing even without the lock, but the lock avoids wasted duplicate work.

**SUB-CRON-009 — Concurrency/failure: a tick runs long enough that its lock TTL would expire mid-run**
Area: concurrency · Criticality: High · Traces to: `LOCK_TTL_SECONDS=900` deliberately 3× the 5-min cadence (code comment explicitly reasons about this).
Preconditions: simulate a tick that takes >5 min (e.g., a huge same-day cohort).
Expected: the 15-minute TTL still covers the run; a second scheduled tick 5 min later fails to acquire the lock and skips. Verify the *batching* (500-row bounded batches, looped) is what keeps a single tick's duration bounded in practice — not solely the TTL margin.

**SUB-CRON-010 — Concurrency: a row changes state between the cron's inner SELECT and its outer UPDATE (EvalPlanQual re-validation)**
Area: concurrency · Criticality: **Critical** · Traces to: BR-S13's repeated-predicate pattern; code comment explains this exact scenario.
Preconditions: row is `status='trialing'`, `trialEndsAt`=now−1s (eligible for `expireTrials`). Concurrently, in a separate transaction, the owner completes checkout+verify (`activateFromPayment`) for this same account between the cron's inner snapshot and its outer UPDATE acquiring the row lock.
Steps: simulate the interleaving (or reason from the code: the outer `UPDATE…WHERE status='trialing' AND trialEndsAt<now` re-checks live committed state via Postgres's MVCC/EvalPlanQual before applying).
Expected: whichever transaction commits second sees the row's *current* state and its predicate no longer matches (`status` is now `'active'`) → the cron's UPDATE affects 0 rows for this account → the row correctly stays `active`, not clobbered back to `expired`. This is the single most important concurrency invariant in the cron and must be verified, not just read as "probably fine."

**SUB-CRON-011 — Boundary: mass same-day expiry runs as multiple bounded batches, not one giant transaction**
Area: boundary/failure · Criticality: High · Traces to: `TRANSITION_BATCH_SIZE=500`, `runTransitionInBatches` loops until a short batch.
Preconditions: 1,200 trials all expiring in the same tick.
Expected: 3 separate transactions of ≤500 rows each (500, 500, 200) rather than one 1,200-row transaction; each batch's outbox rows commit atomically with that batch's UPDATE (not deferred to the end).

**SUB-CRON-012 — Failure: cron encounters a DB error mid-run**
Area: failure · Criticality: High · Traces to: `reconcile()`'s outer try/catch; `stats.lastError` recorded; lock released in `finally` regardless.
Steps: 1) Force a DB error inside `runTransitionInBatches`.
Expected: error caught, logged, `getStats().lastError` populated for `/health/crons`; Redis lock still released in `finally` (not stranded for the full 900s TTL) so the next tick can retry cleanly; any batches that *did* commit before the error stay committed (partial progress is safe/idempotent, not rolled back as a whole).

---

### 3.9 Audit Outbox Drain

**SUB-OUTBOX-001 — Happy: pending row drained to `audit_logs`, marked processed**
Area: happy · Criticality: Medium · Traces to: `drainOutbox`.
Expected: row's `processed_at` set; corresponding `audit_logs` row exists with `entityType:'Subscription'`.

**SUB-OUTBOX-002 — Rule: audit write + outbox ack commit atomically**
Area: rule · Criticality: High · Traces to: `uow.execute` wraps both `audit.logInTransaction` and `markOutboxProcessed`.
Steps: 1) Force the audit insert to fail after acquiring the transaction.
Expected: `processed_at` is **not** set (rollback) — the row remains pending and will be retried on the next drain tick, never silently lost, never double-audited.

**SUB-OUTBOX-003 — Edge: no resolvable actor (account owner already deleted/mid-deletion)**
Area: edge · Criticality: Medium · Traces to: `findAccountOwnerUserId` returns null and payload has no `actorUserId`.
Expected: row is marked processed immediately without writing an audit_logs row (rather than looping forever unprocessable) — "mark processed to avoid an unprocessable row wedging the queue."

**SUB-OUTBOX-004 — Failure/recovery: poison row retried up to `MAX_OUTBOX_ATTEMPTS` then dead-lettered**
Area: failure · Criticality: High · Traces to: `MAX_OUTBOX_ATTEMPTS=5`, `deadLetterOutbox`.
Preconditions: a row that permanently fails to audit-log (e.g., malformed payload causing a constraint violation every time).
Steps: 1) Run `drainOutbox()` 5+ times.
Expected: attempts increments each failed pass; on reaching 5, `dead_lettered_at` is stamped and `processed_at` set (leaves the pending scan) so it never head-of-line-blocks `findPendingOutbox`'s oldest-first ordering for every other account's events.

**SUB-OUTBOX-005 — Concurrency: two drain instances tick simultaneously (Redis lock)**
Area: concurrency · Criticality: Medium · Traces to: `DRAIN_LOCK` `SET NX EX 900`.
Expected: same as SUB-CRON-008 pattern — only one instance drains per tick.

---

### 3.10 SubscriptionStatusGuard — the write-gate

**SUB-GUARD-001 — Happy: `active` account, write allowed**
Area: happy · Criticality: Critical · Traces to: BR-S19.
Expected: mutating request (POST/PUT/PATCH/DELETE) succeeds; `X-Subscription-Version` header present on the response.

**SUB-GUARD-002 — Rule: reads are never blocked regardless of status**
Area: rule · Criticality: **Critical** · Traces to: `READ_METHODS`.
Preconditions: 5 sub-cases across every blocking status (`paused`, `expired`, `past_due`-grace-over via soft check, `reconciliationStatus='pending'`, `storeContext.isLocked=true`).
Steps: 1) `GET` a store-scoped resource under each precondition.
Expected: all five → 200. Confirms BR-002/the module's core non-negotiable principle holds for every single blocking condition, not just the obvious ones.

**SUB-GUARD-003 — Rule violated: `paused` blocks writes regardless of `accessValidUntil`**
Area: rule (violated) · Criticality: Critical · Traces to: `SUSPENDED_STATUSES`.
Preconditions: `status='paused'`, `accessValidUntil` = now+30d (far in the future — administratively irrelevant).
Steps: 1) Attempt a write.
Expected: 403 `subscription_suspended`, even though the access window is nowhere near expired — `paused` is checked *before* the access-window check and short-circuits it.

**SUB-GUARD-004 — Rule: `expired` status blocks even if `accessValidUntil` were somehow still in the future (defense in depth / data-inconsistency case)**
Area: negative/data-integrity · Criticality: High · Traces to: `PAYMENT_REQUIRED_STATUSES` checked before the soft `accessValidUntil` check.
Preconditions: (contrived, to test ordering) `status='expired'` but `accessValidUntil` manually set to now+1d.
Expected: still 402 — the explicit status check fires first regardless of the timestamp.

**SUB-GUARD-005 — Rule violated / data-integrity gap: `cancelled` status alone (with a *future* `accessValidUntil`) does NOT block**
Area: negative/data-integrity · Criticality: **High** · Traces to: `PAYMENT_REQUIRED_STATUSES = {'expired'}` only — `'cancelled'` relies entirely on the soft `accessValidUntil<now` fallback, which is a separate, independent invariant.
Preconditions: (data-integrity edge, should never happen via normal code paths, but worth locking down with a test) `status='cancelled'`, `accessValidUntil` manually/erroneously set to a future date.
Steps: 1) Attempt a write.
Expected (as shipped): **write is allowed** — the guard has no explicit block for `'cancelled'`. This means the *entire* protection for a cancelled-and-lapsed account rests on `accessValidUntil` always being correctly stamped in the past by `expireCancelledAtPeriodEnd`; there is no redundant status-based backstop the way `expired`/`paused` have. Recommend either adding `'cancelled'` to `PAYMENT_REQUIRED_STATUSES` as defense-in-depth, or explicitly documenting that `accessValidUntil` is the sole source of truth for this status.

**SUB-GUARD-006 — Rule: soft block fires when `accessValidUntil` has passed but the cron hasn't run yet (status still `active`)**
Area: rule/timing · Criticality: **Critical** · Traces to: the soft-block branch exists specifically for this cron-lag window.
Preconditions: `status='active'` (cron tick hasn't fired since period end), `currentPeriodEnd`/`accessValidUntil` = now−2min.
Steps: 1) Attempt a write within the up-to-5-minute cron-lag window.
Expected: 402 `subscription_payment_required` — the server-side gate does **not** wait for the cron to catch up; it's authoritative on every request via the live `accessValidUntil` read (or its 5-min-TTL cache copy — see SUB-GUARD-012 for the cache-staleness interaction).

**SUB-GUARD-007 — Rule: reconciliation-pending blocks all writes account-wide, even for a store that itself is under limit**
Area: rule · Criticality: **Critical** · Traces to: BR-S14.
Preconditions: account has 2 stores under a plan now allowing only 1; `reconciliationStatus='pending'`. Attempt a write against the store the owner *intends* to keep (not the over-limit one).
Expected: 403 `subscription_reconciliation_required` even on the "keeper" store — the block is account-wide until the owner explicitly resolves, not store-by-store.

**SUB-GUARD-008 — State: store-level lock (post-resolution) blocks writes independently of the account-wide pending gate**
Area: state · Criticality: High · Traces to: `storeContext?.isLocked` check, independent of `reconciliationStatus`.
Preconditions: reconciliation already resolved (`reconciliationStatus='applied'`), Store 2 is `locked=true` as the resolution outcome.
Steps: 1) Write against Store 2. 2) Write against Store 1 (kept, unlocked).
Expected: (1) 403 `store_locked`; (2) 200 — confirms the two gates (account-wide pending vs per-store locked) are independent and both correctly enforced at their own scope.

**SUB-GUARD-009 — Escape hatch: `@AllowExpiredSubscription()` lets a write through on a lapsed account**
Area: rule · Criticality: Medium · Traces to: `ALLOW_EXPIRED_SUBSCRIPTION_KEY` reflector.
Preconditions: a hypothetical handler decorated `@AllowExpiredSubscription()` (used for genuinely read-adjacent or account-recovery mutations); account is `expired`.
Expected: request proceeds past the write-gate. **QA note:** audit every actual usage of this decorator in the codebase (outside this module) to confirm none of them is a mutation that should have been blocked — this decorator is a deliberate bypass and any misuse is a Critical subscription-bypass bug by definition.

**SUB-GUARD-010 — Negative / doc-vs-code conflict: no `account_subscriptions` row at all**
Area: negative/state · Criticality: **Critical** · Traces to: BR-S2, OQ-A1.
Preconditions: an account somehow has no subscription row (should be impossible given BR-004's atomic creation, but test defensively — e.g., a data-migration gap, or a manually-inserted account/store bypassing the normal creation path).
Steps: 1) Any request (read or write) against a store under this account.
Expected (as shipped): 403 `subscription_not_found` — **including for GET requests**, since this check happens *before* the `READ_METHODS` bypass in `canActivate`. This directly contradicts PRD BR-002 ("reads are never blocked") and BR-026 ("no row → fallback to free, not an error") simultaneously. This is the loudest concrete instance of OQ-1's underlying theme: reads are blocked in exactly this one case. Flag as Critical.

**SUB-GUARD-011 — Negative: guard invoked without a preceding tenant guard (no `request.context.accountId`)**
Area: negative · Criticality: Medium · Traces to: `resolveAccountId` returns undefined → fail-safe 403.
Expected: 403 `store_context_missing` — fails closed, never open, if wired incorrectly onto a route lacking `TenantGuard` ahead of it.

**SUB-GUARD-012 — Cross-cutting/freshness: stale cache serves an old (pre-payment) snapshot for up to 5 minutes**
Area: cross-cutting · Criticality: High · Traces to: PRD §19's documented stale window; versioned cache key scheme.
Preconditions: subscription just activated (version bumped, pointer key deleted per `SubscriptionService.invalidateCache`).
Steps: 1) Immediately after activation, make a write request.
Expected: pointer key miss → guard falls through to DB → fresh state read and re-cached under the new version key → write allowed on the very next request (not a 5-minute wait) — confirms the *versioned*-key + *post-commit-delete* design (not the old fixed-key + explicit-DEL race the PRD describes as superseded) actually collapses the stale window to effectively zero for the write-gate itself. Contrast with the *client's* own stale window (bounded by its own poll/version-check cadence), which is a separate, client-side concern.
Notes: this specific test validates that `SubscriptionService.invalidateCache`'s `redis.del(subVersionPointerKey(accountId))` and the guard's read-the-pointer-then-read-the-snapshot pattern actually compose correctly — a subtle two-key cache scheme is exactly where an invalidation can silently not take effect.

**SUB-GUARD-013 — Failure: Redis unavailable during guard's cache read — falls back to DB, does not fail the request**
Area: failure · Criticality: **High** · Traces to: `loadSubscription`'s explicit try/catch around the cache read.
Preconditions: Redis down.
Expected: guard falls through to the DB query cleanly, still enforces correctly (just slower / no cache-write side effect, itself also wrapped in try/catch) — **contrast this correct pattern directly against SUB-VF-007's uncaught Redis read in `billing.service.ts`'s `readOrder`**, which does not have this protection. Same module, two different resilience postures for the same class of dependency failure.

---

### 3.11 Entitlement Service

**SUB-ENT-001 — Rule: missing entitlement row is blocked (0), not unlimited**
Area: rule · Criticality: **Critical** · Traces to: BR-S18; explicit code comment warns against `?? null` collapsing this.
Preconditions: a plan's `plan_entitlements` seed is missing a `max_devices_per_store` row entirely (seed gap).
Steps: 1) `entitlements.get(accountId, 'max_devices_per_store')`.
Expected: returns `0` (not `null`) — the account is entitled to **zero** devices per store on this plan, not unlimited. This is the single most dangerous entitlement bug shape (a silent-unlimited-grant on a seed gap) and must have a dedicated regression test.

**SUB-ENT-002 — Rule: explicit `NULL` value means unlimited**
Area: rule · Criticality: High · Traces to: `growth` plan's `max_stores: null` seed.
Steps: 1) `entitlements.get(accountId-on-growth, 'max_stores')`.
Expected: returns `null`; `canCreate(null, 999)` → `true`.

**SUB-ENT-003 — Boundary: strict less-than at exactly the limit**
Area: boundary · Criticality: **Critical** · Traces to: BR-029 / `canCreate`.
Preconditions: `limit=5`, `current=5`.
Expected: `canCreate(5,5) === false` (at-limit blocks the *next* create, existing 5 keep working) — not `<=`.

**SUB-ENT-004 — Boundary: one below the limit is allowed**
Area: boundary · Criticality: High · Input: `limit=5`, `current=4`. Expected: `true`.

**SUB-ENT-005 — Boundary: limit=0 blocks unconditionally**
Area: boundary · Criticality: Medium · Input: `limit=0`, `current=0`. Expected: `canCreate(0,0)===false` (0 is never `> current` in a way that allows — `0 < 0` is false).

---

### 3.12 Downgrade Detection

**SUB-DG-001 — Happy: plan change that stays within limits does not freeze the account**
Area: happy · Criticality: Critical · Traces to: `isOverLimit` returns false → `activateFromPayment` skips reconciliation entirely.
Preconditions: account has 1 active store, upgrades `starter→growth` (unlimited stores).
Expected: `reconciliationStatus` stays `'none'`; no lock/revoke side effects.

**SUB-DG-002 — Rule: downgrade over `max_stores` freezes the account**
Area: rule · Criticality: **Critical** · Traces to: `isOverLimit` store-count check.
Preconditions: account on `growth` (unlimited) with 3 active stores, downgrades to `starter` (`max_stores=1`).
Steps: 1) Complete checkout+verify for `starter_monthly`.
Expected: `activateFromPayment` commits the plan change **and**, in the same transaction, sets `reconciliationStatus='pending'` — all 3 stores remain `locked=false` at this point (nothing is auto-locked yet; only the owner's later resolve call locks/revokes). All writes account-wide now blocked per SUB-GUARD-007.

**SUB-DG-003 — Rule: downgrade over `max_devices_per_store` on just ONE store (store count itself fine) still freezes the account**
Area: rule/boundary · Criticality: **Critical** · Traces to: `isOverLimit`'s per-store device loop — code comment: "a downgrade can leave the store count fine while one specific store is over on devices."
Preconditions: account has exactly 1 store (fine for `max_stores=1` on Starter) with 8 active device slots, downgrades from `growth` (20 devices/store) to `starter` (5 devices/store).
Expected: `reconciliationStatus='pending'` — even though `max_stores` itself is satisfied.

**SUB-DG-004 — Rule: `max_products` is never checked here, by design**
Area: rule/boundary · Criticality: Medium · Traces to: BR-S17.
Preconditions: account has 500 products, downgrades to a plan with `max_products=10`.
Expected: `isOverLimit` returns based purely on stores/devices — a products-only overage does **not** freeze the account. (This is documented-intentional, not a bug — but worth a regression test precisely because it's counter-intuitive versus the entitlement's own existence.)

**SUB-DG-005 — Concurrency: `isOverLimit`'s row lock serializes against a concurrent `createStore`**
Area: concurrency · Criticality: **Critical** · Traces to: `stores.lockAccount(accountId, tx)` inside `isOverLimit`, "same account-row lock createStore takes."
Preconditions: a plan downgrade to `max_stores=1` commits at the same instant a separate request is mid-flight creating a 2nd store under the *old* plan's still-cached limit.
Steps: simulate the race: downgrade's `isOverLimit` check and `createStore`'s own limit recheck both contend for the same account row lock.
Expected: one transaction's lock acquisition blocks until the other commits; whichever runs second re-reads live (already-updated) state — the account can never end up with 2 active stores on a 1-store plan with neither request detecting it. This is the exact race the shared row lock exists to prevent — must be verified under real concurrent load, not just read as correct.

---

### 3.13 Reconciliation Resolve — `GET`/`POST /me/subscription/reconciliation`

**SUB-DG-006 — Happy: owner resolves a downgrade, choosing 1 of 2 stores to keep**
Area: happy · Criticality: Critical · Traces to: `ReconciliationService.apply`.
Preconditions: `reconciliationStatus='pending'`, 2 active stores (A: 3 devices, B: 2 devices), plan now allows `max_stores=1`, `max_devices_per_store=5`.
Input: `{keep_store_ids:[A.id], keep_device_ids:[A.device1, A.device2, A.device3]}`.
Steps: 1) POST reconciliation resolve.
Expected: 200 `{applied:true}`; Store B `locked=true, lockedReason='downgrade'`; all of Store A's devices remain active (within the new 5-device limit); `reconciliationStatus='applied'`, `reconciliationEffectiveAt=now`; writes unblock account-wide (except Store B itself, now individually locked).

**SUB-DG-007 — Rule violated: selection exceeds the new store limit**
Area: rule (violated) · Criticality: High · Traces to: `validate()` — `keepStoreIds.length > maxStores`.
Input: `keep_store_ids` listing both stores when `max_stores=1`.
Expected: 422 `reconciliation_invalid` with `details.fieldErrors.keepStoreIds` describing the overage. No partial apply — nothing locked/revoked.

**SUB-DG-008 — Rule violated: selection includes a store/device id that doesn't belong to this account**
Area: negative · Criticality: **Critical** (tenancy) · Traces to: `validate()` — id-set membership checks before any limit check.
Input: `keep_store_ids` containing another account's store UUID.
Expected: 422 `reconciliation_invalid`, `fieldErrors.keepStoreIds` — "one or more selected stores don't exist" (from this account's point of view; never leaks whether the id belongs to someone else).

**SUB-DG-009 — Rule violated: self-lockout — owner's current device's only kept-store entry gets dropped**
Area: rule (violated) · Criticality: **Critical** · Traces to: BR-S15.
Preconditions: caller's current device is active only in Store B; selection keeps Store A only.
Expected: 422 `reconciliation_invalid` — "You can't remove every store/device you're currently using…". Nothing applied.

**SUB-DG-010 — Rule satisfied: self-lockout guard correctly allows a selection when the current device holds slots in MULTIPLE stores and at least one is kept**
Area: rule · Criticality: **Critical** (regression-shaped — the exact bug the ANY-check comment says it replaces) · Traces to: reconciliation.service.ts:500-526's explicit "must be an ANY check, not the first entry found" comment.
Preconditions: current device has active slots in both Store A and Store B; owner keeps only Store A (drops B).
Expected: 200, applied successfully — the naive "check only the device's first listed slot" bug this code explicitly guards against would have failed this exact case if the *first* slot happened to be Store B.

**SUB-DG-011 — Concurrency: two resolve calls race for the same account (double-tap on "Confirm")**
Area: concurrency · Criticality: **Critical** · Traces to: `stores.lockAccount(accountId, tx)` taken before `getContext` re-read, inside `apply()`.
Steps: 1) Fire two POST reconciliation-resolve calls with *different* selections, simultaneously.
Expected: one call's transaction acquires the account row lock first and fully commits (locks/revokes per its selection, sets `reconciliationStatus='applied'`); the second call, once it acquires the lock, re-reads live state via `getContext(accountId, currentDeviceId, tx)` — by then Store B (say) may already be locked, changing what `ctx.stores` contains for its own validation. Confirm the final state matches exactly one caller's intent (whichever committed second, since it validates against the fresh live state, not a stale pre-lock snapshot) and never leaves an inconsistent, partially-mixed outcome.

**SUB-DG-012 — Recovery: re-upgrade auto-restores everything exactly, skipping a device that already reclaimed a fresh slot**
Area: happy/recovery · Criticality: Critical · Traces to: BR-S16, `ReconciliationService.autoRestore`.
Preconditions: Store B locked, its 2 devices revoked `reason='plan_downgrade'`. Owner upgrades back to a plan covering both stores. Meanwhile, one of Store B's revoked devices was manually re-registered fresh (new active slot) in the interim on a *different* store, before the upgrade.
Steps: 1) Complete checkout+verify for the covering plan.
Expected: Store B unlocked; the still-revoked (never-reclaimed) device is restored to active; the device that already claimed a fresh slot elsewhere is **skipped** (not resurrected as a stale duplicate slot) — per `restoreSlot`'s explicit no-op-if-already-active guard.

**SUB-DG-013 — Edge: reconciliation GET is safe to call even when nothing is pending**
Area: edge · Criticality: Low · Traces to: controller doc comment — "always safe to call."
Preconditions: `reconciliationStatus='none'`.
Expected: 200, returns every currently-active store/device and the plan's current limits — not an error, not an empty payload.

---

### 3.14 Active-Store Swap — `POST /me/subscription/active-store`

**SUB-SWAP-001 — Happy: swap which store is active post-downgrade, without redoing full resolve**
Area: happy · Criticality: High · Traces to: `ReconciliationService.swapActiveStoreForUser`.
Preconditions: Store A active, Store B locked (from an earlier resolve). Owner wants B active, A locked instead (1-store plan).
Input: `{activate_store_id:B, deactivate_store_id:A, keep_device_ids:[B.device1]}`.
Expected: 200; A now `locked=true`, B now `locked=false`; B's kept device restored active, any other of B's previously-active devices revoked `plan_downgrade`.

**SUB-SWAP-002 — Rule violated: target "deactivate" store isn't actually active**
Area: rule (violated) · Criticality: Medium · Traces to: `validateSwap` — `!deactivate || deactivate.locked`.
Input: `deactivate_store_id` already locked.
Expected: 422 `deactivate_store_not_active`.

**SUB-SWAP-003 — Rule violated: target "activate" store isn't actually locked**
Area: rule (violated) · Criticality: Medium · Traces to: `validateSwap` — `!activate || !activate.locked`.
Expected: 422 `activate_store_not_locked`.

**SUB-SWAP-004 — Rule violated: kept device doesn't belong to the target store**
Area: negative/tenancy · Criticality: High · Traces to: `targetDeviceIds` membership check.
Expected: 422 `unknown_device`.

**SUB-SWAP-005 — Rule violated: kept devices exceed the plan's per-store device limit**
Area: rule (violated) · Criticality: High · Traces to: `keepDeviceIds.length > limits.maxDevices`.
Expected: 422 `over_device_limit`.

**SUB-SWAP-006 — Rule violated: self-lockout — caller's current device is in the store about to be deactivated and isn't kept on the new one**
Area: rule (violated) · Criticality: **Critical** · Traces to: `validateSwap`'s BR-DEV-005-equivalent guard, mirrored from `validate()`.
Preconditions: caller's current device is active in `deactivateStoreId` only; `keep_device_ids` for the activate-store swap doesn't include it.
Expected: 422 `reconciliation_invalid` — "you'd be signed out with no way back in."

**SUB-SWAP-007 — Concurrency: swap races with a full resolve() for the same account**
Area: concurrency · Criticality: **Critical** · Traces to: both take `stores.lockAccount` first — "the same reason: without it, two concurrent apply()/apply() or apply()/swap() calls … can both commit, leaving the account over its plan limits."
Steps: fire `POST reconciliation` (full resolve) and `POST active-store` (swap) simultaneously for the same account.
Expected: serialized by the shared account-row lock; final state is internally consistent (never more active stores than the plan allows, never a device slot double-restored).

---

### 3.15 RBAC / Permission Cases (cross-cutting across all billing endpoints)

**SUB-RBAC-001 — Permission satisfied: the true account owner can perform every billing action**
Area: permission · Criticality: Critical · Traces to: all `requireOwnedAccount` call sites.
Expected: checkout, verify, cancel (+step-up), reactivate (+step-up), reconciliation GET/POST (+step-up), active-store swap (+step-up) — all succeed for the owner.

**SUB-RBAC-002 — Permission violated: a `cashier`-role member cannot perform any billing action**
Area: permission · Criticality: Critical · Expected: 403 `not_account_owner` on every endpoint above.

**SUB-RBAC-003 — Permission violated / PRD conflict: a `co_owner`-role member cannot perform any billing action either**
Area: permission (violated vs. PRD) · Criticality: **Critical** · Traces to: OQ-2.
Preconditions: `account_users` row with `role='co_owner'` exists for this user.
Expected (as shipped, code-accurate): 403 `not_account_owner` on checkout/cancel/reactivate/reconciliation/swap — **despite** PRD §16's table explicitly granting co_owner all of these. This is the highest-value RBAC finding: either the code needs to check `account_users.role IN ('owner','co_owner')` (and `accountant` for checkout/pay only, per PRD footnote ¹), or the PRD needs correcting. Either way, ship a decision, not silence.

**SUB-RBAC-004 — Permission: a user who belongs to zero accounts gets a clean 403/404, never a crash**
Area: negative · Criticality: Medium · Traces to: `findOwnedAccountId`/`findMemberAccountId` both return `null` cleanly.
Expected: 403 `not_account_owner` (billing actions) or 404 `subscription_not_found` (read-model), never a 500.

**SUB-RBAC-005 — Permission changed mid-flow: user's role is downgraded from owner to co_owner between checkout and verify**
Area: permission (mid-flow) · Criticality: **High** · Traces to: `verify()` re-checks `requireOwnedAccount` fresh, not off any cached role from checkout time.
Preconditions: checkout succeeds while user is owner; ownership is transferred to someone else (PRD §16 Case A) before the user calls verify.
Steps: 1) checkout as owner. 2) ownership transfer occurs. 3) same user calls verify.
Expected: 403 `not_account_owner` on verify — the payment order still exists durably and its `accountId` is unchanged, so a *new* owner (or the account itself, via a fresh verify call from the new owner) could still complete verification; the now-demoted former owner cannot. Confirms the ownership check is re-evaluated live at every billing call, not cached from checkout.

---

## 4. Edge-Case Scenarios (§5 checklist, explicitly called out)

**EDGE-001 — Empty selection on reconciliation resolve (owner keeps zero stores)**
Area: edge/boundary · Criticality: High · Traces to: `validate()` — `keepStoreIds:[]`.
Steps: `POST reconciliation` with `{keep_store_ids:[], keep_device_ids:[]}`.
Expected: passes the "more than limit" check trivially (0 ≤ any limit), but the self-lockout guard fires (the caller's current device can't be in any kept store if none are kept) — **unless** the caller isn't currently active in any store at all (e.g., resolving from a device that's never claimed a slot), in which case this literally locks every store. Confirm whether an empty-keep selection should be blocked outright as a distinct rule (a business with zero active stores is arguably always invalid) or is intentionally allowed via the self-lockout guard alone.

**EDGE-002 — First-run: brand-new trial account with `trial_ends_at` far in the future — banner is `info`, not silent**
Area: first-run · Criticality: Medium · Traces to: SUB-VIEW-009.
Expected: `banner_severity:'info'`, confirming a fresh trial isn't mistaken for "nothing to show" the way `active` is.

**EDGE-003 — Maximum: `subscription_version` at `INTEGER` boundary (very long-lived account, thousands of transitions)**
Area: max/overflow · Criticality: Low · Traces to: `integer('subscription_version')`.
Expected: Postgres `integer` max is 2,147,483,647 — at realistic transition rates (a handful per billing cycle) this is not reachable in practice, but confirm no `smallint` truncation anywhere in the DTO/response layer (`subscription_version: number` in TS — fine up to 2^53).

**EDGE-004 — Decimals/rounding: `savings_percentage` rounding at an exact half-percent**
Area: decimals · Criticality: Low · Traces to: `Math.round(...)` in `getPlanCatalog`.
Preconditions: construct a monthly/annual pair whose raw percentage lands exactly on `x.5`.
Expected: `Math.round` banker's/standard rounding (rounds half away from zero for positive inputs in JS) — verify the displayed percentage matches what marketing actually promised (₹499×12=5988 vs ₹4999 → (5988-4999)/5988 = 16.51% → rounds to 17%, matches PRD's "≈17% off" claim).

**EDGE-005 — Duplicate/repeat: the exact same webhook byte-for-byte, replayed by an attacker who captured it off the wire (replay attack)**
Area: duplicate/security · Criticality: **Critical** · Traces to: HMAC signature has no timestamp/nonce component in the code as read (`verifyWebhook` signs the raw body only) — a captured valid webhook body+signature pair remains verifiably "valid" forever.
Expected: replay is **safe from a money standpoint** (BR-S5's `providerRef` claim makes any replay a no-op), but confirm there's no *other* replay-sensitive side effect (there isn't one visible in this module — the only effect of a webhook is the idempotent activation). Flag as a documented residual risk, not a fix-required bug: signature freshness (nonce/timestamp) is a defense-in-depth gap, but the actual state-mutation is already replay-safe by construction.

**EDGE-006 — Out-of-order: cron's four sweeps run in a fixed order each tick — does an account that qualifies for two sweeps in the same tick get processed correctly?**
Area: out-of-order · Criticality: **Critical** · Traces to: `reconcile()`'s call order: cancelled → trialed → past-dued → grace-ended.
Preconditions: contrive a row that could match two predicates in the same tick — in practice the enum/predicate design makes every pair mutually exclusive (e.g., `expireCancelledAtPeriodEnd` requires `status='active'`, `expireActiveToPastDue` also requires `status='active'` but excludes `cancelAtPeriodEnd=true`), so this should be structurally impossible. Write the test anyway to lock in that guarantee: seed a row satisfying `status='active', cancelAtPeriodEnd=true, currentPeriodEnd<now` and confirm it is matched by **exactly one** of the four sweeps, never zero, never two, in a single `reconcile()` call.

**EDGE-007 — Clock skew: server clock and cron's `now` reference disagree slightly across the 4 sweeps within one `reconcile()` call**
Area: time · Criticality: Medium · Traces to: `reconcile()` computes `const now = new Date()` **once** at the top and threads it through all four sweeps — confirms all four use the *same* instant, not four separately-read clocks that could disagree by milliseconds and create a gap where a row is briefly eligible for two sweeps' predicates without either catching it. Good design; write the regression test to keep it that way.

**EDGE-008 — Permission/subscription change mid-flow: subscription lapses between a cashier opening the checkout screen (as a delegate showing the owner) and the owner actually submitting payment**
Area: permission/subscription mid-flow · Criticality: Medium · Traces to: `requireOwnedAccount` + the guard's live check — both re-evaluated per-request, not cached across the flow.
Expected: irrelevant to *checkout* itself (checkout/verify are never blocked by `SubscriptionStatusGuard`, since that guard only wraps store-scoped routes, not `MeSubscriptionController`) — a lapsed account can always still check out and pay to recover, which is the entire point of the flow. Confirm this is true: **checkout/verify must never be blocked by the write-gate**, or a lapsed account could never pay its way back to active.

**EDGE-009 — Abandonment: owner starts reconciliation resolve, the app is killed before submitting**
Area: abandonment · Criticality: Low · Traces to: `apply()` is a single all-or-nothing transaction; nothing is applied client-side until POST succeeds.
Expected: `reconciliationStatus` remains `'pending'`; nothing partially locked/revoked; owner can resume the resolve flow at any time — GET reconciliation is always safe to re-fetch (SUB-DG-013).

**EDGE-010 — Long/unusual input: `plan_code` containing SQL-injection-shaped or path-traversal-shaped strings**
Area: negative/security · Criticality: Medium · Traces to: `PLAN_PRICING` is a plain object lookup (`PLAN_PRICING[planCode]`), never interpolated into a query string.
Input: `{plan_code:"'; DROP TABLE plans; --"}`, `{plan_code:"__proto__"}`.
Expected: both → 422 `unknown_plan_code` (simple key-miss on a plain object; `__proto__` specifically — confirm `Object.prototype` pollution isn't possible via this lookup path, since `PLAN_PRICING.__proto__` would resolve to `Object.prototype` itself, which is truthy but shaped nothing like a `PlanPrice` — verify `resolvePlanPrice('__proto__')`'s actual return value defensively, since `??` only catches `undefined`/`null`, not an unexpectedly-truthy prototype object).

**EDGE-011 — Unicode/emoji: n/a for this module's actual free-text inputs** — this module has no free-text fields (plan codes, order ids, uuids only); note as "not applicable" rather than skipping silently, since the checklist calls for it.

**EDGE-012 — State edge: acting on an already-`applied` reconciliation a second time (owner changes their mind after already resolving)**
Area: state edge · Criticality: Medium · Traces to: `apply()` has no guard against `reconciliationStatus` already being `'applied'` — it will simply re-run against current live state.
Steps: 1) Resolve once (Store B locked). 2) POST reconciliation again with a *different* selection (now keep Store B, drop A).
Expected: since `getContext` only lists **currently-active** stores (Store B, now locked, is excluded from `ctx.stores` — see `listActiveStores`'s `locked=false` filter), a second full `apply()` call cannot re-select an already-locked store at all; the owner must use the active-store **swap** endpoint instead to reach into an already-locked store. Confirm this is the intended UX (resolve = only for the initial unresolved set; swap = the only path to touch an already-locked store afterward) and that attempting `keep_store_ids:[B.id]` on the resolve endpoint post-resolution fails cleanly with `reconciliation_invalid` ("store doesn't exist" from this account-active-stores point of view) rather than a confusing error.

---

## 5. Coverage Summary — Requirement/Rule → Case Matrix

| Business rule | Satisfied case(s) | Violated case(s) |
|---|---|---|
| BR-S1 (one sub/account) | schema constraint, implicit in all happy cases | n/a (DB-level unique constraint, not app-testable without a raw insert) |
| BR-S2 (status enum, no `free`) | SUB-VIEW-002 (fallback via null planCode, not a `free` status) | SUB-GUARD-010 |
| BR-S3 (7-day grace) | SUB-CRON-003 | n/a — constant, not configurable per-account |
| BR-S4 (period length by billing cycle) | SUB-VF-001 (monthly), SUB-CO-001 | need an explicit **annual** activation case — see gap below |
| BR-S5 (payment idempotency) | SUB-VF-005, SUB-VF-006, SUB-WH-009 | n/a (rule has no "violated" shape — it's a guarantee) |
| BR-S6 (durable order fallback) | SUB-VF-007 (fallback intent) | SUB-VF-007 (fallback broken by uncaught Redis error) |
| BR-S7 (order ownership binding) | — | SUB-VF-004 |
| BR-S8 (amount mismatch defence) | SUB-WH-001 (matches) | SUB-WH-007, recovers SUB-WH-008 |
| BR-S9 (cancel requires active) | SUB-CX-001 | SUB-CX-002 |
| BR-S10 (reactivate requires active) | SUB-RX-001 | SUB-RX-002 |
| BR-S11 (step-up on cancel/reactivate/reconciliation/swap) | SUB-CX-007 (within window) | SUB-CX-006, SUB-CX-007 (over window) |
| BR-S12 (version+outbox atomicity) | all `*-001` happy cases implicitly | SUB-CX-003/SUB-RX-003 (no-op paths correctly skip both) |
| BR-S13 (cron batching/atomicity) | SUB-CRON-011 | SUB-CRON-010 (concurrent mutation during sweep) |
| BR-S14 (account-wide reconciliation freeze) | SUB-DG-002/003 | SUB-GUARD-007 (keeper store still blocked) |
| BR-S15 (self-lockout, ANY-check) | SUB-DG-010 | SUB-DG-009, SUB-SWAP-006 |
| BR-S16 (exact auto-restore) | SUB-DG-012 | — (no "violated" shape; it's a recovery guarantee) |
| BR-S17 (max_products never gates) | SUB-DG-004 | n/a — intentional non-rule |
| BR-S18 (missing-row = 0, null = unlimited) | SUB-ENT-002 | SUB-ENT-001 |
| BR-S19 (guard priority order) | SUB-GUARD-001/002 | SUB-GUARD-003 through -008, -010 |
| BR-S20 (flat lowercase error envelope) | all negative cases implicitly (`errorCode` field) | — |
| BR-S21 (webhook HMAC-only auth) | SUB-WH-001 | SUB-WH-002, SUB-WH-003 |
| BR-S22 (no real recurring charge) | SUB-CRON-003 (default-to-past_due behavior) | — (documented design, not a violable rule) |
| BR-S23 (banner gap) | SUB-VIEW-008 (expired, works) | SUB-VIEW-005, -006, -007 (**Critical, unresolved**) |

### Coverage gaps identified (things this document flags as needing an additional case, or a product decision, before sign-off)

1. **No explicit annual-cycle activation test case is listed above beyond the rule table** — add a
   concrete `SUB-VF-00X` variant asserting `currentPeriodEnd = now + 365d` (not 30d) for
   `growth_annual`/`starter_annual`, and specifically that switching *within* the same plan name from
   monthly→annual (or vice versa) recomputes the period length off the **new** `planCode`, never the
   old one.
2. **No test exists (or can exist, purely at this module's level) for the PRD's `POST /sync/delta`
   three-tier point-in-time/live-recheck model (§7/§23)** — a repo-wide search found no
   `client_modified_at`/tier-based subscription check anywhere in `apps/backend/src/sync/`, only a
   comment referencing `access_valid_until`. If this tiered sync-time check is meant to exist, it is
   currently **unimplemented**, meaning: an offline sale made *before* a subscription lapse could be
   rejected by `SubscriptionStatusGuard`'s live (not point-in-time) check when it finally syncs *after*
   the lapse — the exact scenario PRD R4/§23 promises must never happen. This is out of this module's
   file tree but directly consumes its `access_valid_until` semantics; escalate to whoever owns
   `apps/backend/src/sync/`.
3. **Location (`max_locations_per_store`) and staff (`max_users_per_store`) limits described
   extensively in the PRD (§3A, §11, §18) have no corresponding entitlement key, seed data, or
   enforcement anywhere in this module** — `EntitlementKey` is only `max_stores | max_devices_per_store
   | max_products`. If these limits are enforced elsewhere (a `locations`/`invitations` module), that
   module needs its own QA pass; if not, this is a large PRD-vs-shipped gap outside this document's
   file scope but worth flagging up.

---

## 6. Priority Roll-Up — Run These First

**Critical / money-and-lockout risk (must pass before any release):**
- SUB-VF-005, SUB-VF-006, SUB-WH-009 — no double-charge/double-activation under retry or webhook redelivery.
- SUB-VF-007 — Redis-outage-during-verify does not silently fail a genuinely-paid customer (resilience gap, currently failing as read).
- SUB-CO-008 — Redis-outage-during-checkout doesn't needlessly 500 (resilience gap, currently failing as read).
- SUB-WH-010 — stale/out-of-order webhook cannot silently downgrade an account past a newer paid plan (open design gap, currently failing as read).
- SUB-CX-009 — re-checkout after a period-over cancellation must clear `cancel_at_period_end`, or the freshly-paid subscription silently self-cancels one cycle later (**must verify**, severity TBD pending confirmation).
- SUB-VIEW-005/006/007 — `GET /me/subscription` banner fields are silent for `past_due`/`cancelled`/`paused` (confirmed gap vs PRD; product must confirm intended contract — OQ-1).
- SUB-RBAC-003 — co-owner cannot bill despite PRD claiming they can (OQ-2; ship a decision).
- SUB-GUARD-010 — no-subscription-row blocks **reads** too, contradicting the "reads never blocked" invariant.
- SUB-GUARD-005 — `cancelled` status has no status-level backstop, relies solely on `accessValidUntil` being correctly stamped.
- SUB-CRON-010 — cron's EvalPlanQual concurrency guarantee (a live payment mid-sweep is never clobbered back to expired).
- SUB-DG-005, SUB-DG-011, SUB-SWAP-007 — every account-row-lock-based concurrency guarantee across downgrade detection, resolve, and swap.
- SUB-ENT-001, SUB-ENT-003 — entitlement seed-gap-is-blocked and strict-less-than boundary.
- SUB-DG-009, SUB-DG-010, SUB-SWAP-006 — self-lockout guards (an owner must never be able to sign themselves out with no recovery path).

**High (core flows, common errors, must pass before release, can trail Critical by a day):**
All of §3.3–§3.9's remaining happy/negative/failure cases (checkout, verify, webhook, cancel,
reactivate, cron sweeps, outbox drain) not already listed above.

**Medium/Low:** catalog presentational fields, `feature_labels` dead entries, DTO length-boundary cases, replay-safety documentation (EDGE-005).

---

## 7. Open Questions (need product/dev confirmation to finalize expected results)

- **OQ-1 (Critical):** Is it intentional that `GET /me/subscription`'s `banner_severity`/
  `show_upgrade_banner` fields are silent (`'none'`/`false`) for `past_due`, `cancelled`, and `paused`
  — despite the PRD (§22) explicitly specifying banner text for every one of these — because the
  client is expected to derive its own banner client-side from `status`/`cancel_at_period_end`
  instead? Or is `computeBanner()` missing three `switch` cases that need to be added
  (`subscription.service.ts:336-357`)? This is the single highest-leverage fix candidate in the module
  — until answered, SUB-VIEW-005/006/007 should be treated as failing/Critical.

- **OQ-2 (Critical):** The PRD (§9, §16, §24) repeatedly states `co_owner` (and, for pay-only actions,
  `accountant`) can perform billing actions. The actual code (`requireOwnedAccount` in all three
  services) checks only `accounts.owner_user_fk`, a single-owner column — `account_users.role` is
  never consulted for billing gating anywhere in this module. Is single-owner-only the current,
  intended contract (in which case the PRD needs a correction pass), or is multi-role billing a known
  gap awaiting a follow-up ticket? This affects SUB-CO-005, SUB-CX-005, SUB-RX-004, SUB-RBAC-003 and
  should be resolved with a single, traceable answer before those are marked pass/fail.

- **OQ-3:** Is `max_products` intentionally never enforced by downgrade-reconciliation (BR-S17) meant
  to be permanent (i.e., product limits are enforced only prospectively at product-creation time, in a
  module outside this review), or is a future "product archiving" reconciliation step planned? Affects
  how SUB-DG-004 should be worded in a regression suite (permanent behavior vs. temporary gap).

- **OQ-4:** Confirm the intended resilience posture for `BillingService.readOrder()` /
  `BillingService.checkout()`'s uncaught Redis calls (SUB-VF-007, SUB-CO-008) — should they adopt the
  same try/catch-and-fall-through-to-DB pattern `SubscriptionStatusGuard.loadSubscription` already
  uses, given this module's own design intent (stated in `readOrder`'s comment) is exactly "the durable
  row is the fallback when Redis is unavailable/expired"?

- **OQ-5:** Is there a known, accepted risk that a stale/abandoned checkout order's late-arriving
  webhook can silently overwrite a newer, already-paid, higher plan (SUB-WH-010)? If not accepted,
  should `activateFromPayment` (or `applySuccess`) reject an activation whose order is not the
  account's *most recent* `payment_orders` row, or is order abandonment expected to be prevented
  upstream (e.g., Razorpay order expiry) rather than defended against here?

- **OQ-6:** Does re-checkout after a period-over cancellation (`cancel_at_period_end=true`,
  `status='cancelled'`) actually clear `cancel_at_period_end` somewhere this review didn't find, or
  does `activateFromPayment`'s omission of that field from its `applyTransition` patch mean a freshly
  reactivated subscription silently re-cancels itself at the end of its new period (SUB-CX-009)? This
  needs a direct answer, ideally backed by a passing/failing test, before sign-off — it is the kind of
  bug that would only surface in production a full billing cycle after the fix window has closed.

- **OQ-7:** Is the PRD's documented `POST /sync/delta` three-tier (Tier 0/1/2) point-in-time vs.
  live-recheck model for offline mutations (§7/§23) actually implemented anywhere, given a repo search
  under `apps/backend/src/sync/` found no tier-based `client_modified_at` check — only a guard that
  live-checks `access_valid_until` against `NOW()` unconditionally? If unimplemented, every offline
  sale made before a lapse but synced after it is currently rejected by the live guard check, contrary
  to PRD R4's explicit "no genuine sales lost" guarantee. Out of this module's own file tree, but this
  module (`access_valid_until`) is exactly what such logic would need to consume — flag to the sync
  module's owner.

- **OQ-8:** Are `max_locations_per_store` and `max_users_per_store` (PRD §3A, §11, §17, §18) enforced
  in some other module not covered by this review (e.g., a `locations`/`invitations` service), or are
  they simply not built yet? `EntitlementService`'s `EntitlementKey` type only recognizes
  `max_stores | max_devices_per_store | max_products` — if these two limits are meant to exist today,
  they are entirely absent from the subscription module's own enforcement surface.