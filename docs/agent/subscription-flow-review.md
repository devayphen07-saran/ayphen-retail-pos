# Subscription & Billing — Implementation Review (Mode B)

> Reviewed the entire backend subscription surface against `docs/backend/subscription.md`
> (the authoritative spec) through the six lenses of `CLAUDE-flow-spec.md`. Every claim below
> is cited to `file:line`. The spec in `docs/backend/subscription.md` predates the current code:
> it describes a **synchronous** downgrade (§14) and has **no** `reconciliation_status` model,
> whereas the code implements a **deferred reconciliation** model. Where the code has evolved
> past the doc I judged it on its own internal design intent and flag the doc as stale.

## 1. Verdict

The core money path is **well built and genuinely enterprise-grade**: activation is idempotent by
construction (the payment-event claim and the activation UPDATE share one transaction), audit is an
in-transaction outbox drained by a bounded-retry worker, the cache is versioned so invalidation can
never race a write, the lifecycle cron uses bounded idempotent set-UPDATEs with EvalPlanQual
re-validation and a canonical lock order, and the reconciliation/swap flows re-read live state under
the account row lock before validating. This is careful, senior-level work.

Two things need fixing now. **(P1)** Re-subscribing or upgrading after a cancellation does **not**
clear `cancel_at_period_end`, so a customer who pays to come back is silently re-cancelled at the
next period end. **(P2)** the `banner_severity` / `show_upgrade_banner` fields in `GET /me/subscription`
are computed for only two of the eight states the spec (§22) requires, so past-due-in-grace,
pending-cancel, paused and free-plan accounts get a blank banner in the payload. Then two **policy
divergences** that need an explicit decision rather than a code fix: billing actions are gated on the
single account **owner** only (spec §24 allows co_owner/accountant), and checkout/verify **skip
step-up OTP** (spec BR-020/§9 require it on all billing actions). Everything else is conformant or a
justified, well-commented divergence.

**Fix now:** P1 (`cancel_at_period_end` not cleared on re-activation), P2 (banner coverage).
**Decide, then fix or update the spec:** billing RBAC scope, checkout step-up, Tier-2 sync re-check.
**Later / housekeeping:** cancelled warning header, stale spec doc.

## 2. Conformance matrix (spec item → status → evidence)

| Spec item | Status | Evidence | Note |
|---|---|---|---|
| BR-003/BR-015 trial starts at first store, 15 days, `has_used_trial` | ✅ OK | [store.service.ts:185-190](../../apps/backend/src/stores/store/store.service.ts#L185-L190), `TRIAL_DAYS=15` L16; `startTrial` sets `hasUsedTrial=true` [store.repository.ts:287-295](../../apps/backend/src/stores/store/store.repository.ts#L287-L295) | |
| BR-004 account+sub created atomically pre-trial | ✅ OK | signup bootstrap seeds `trialEndsAt:null, hasUsedTrial:false` [account-bootstrap.repository.ts:58-60](../../apps/backend/src/auth/mobile/repositories/account-bootstrap.repository.ts#L58-L60) | |
| BR-008 `access_valid_until` = single write-gate clock | ✅ OK | guard soft-block [subscription-status.guard.ts:169-171](../../apps/backend/src/auth/mobile/guards/subscription-status.guard.ts#L169-L171); sync gate [delta.service.ts:395-404](../../apps/backend/src/sync/push/delta.service.ts#L395-L404) | |
| BR-009 grace = 7 days, binary | ✅ OK | `GRACE_DAYS=7` [subscription-lifecycle-cron.service.ts:31](../../apps/backend/src/subscription/subscription-lifecycle-cron.service.ts#L31); `expireActiveToPastDue` [subscription.repository.ts:559-579](../../apps/backend/src/subscription/subscription.repository.ts#L559-L579) | |
| BR-018 point-in-time offline write accept | ✅ OK | [delta.service.ts:394-404](../../apps/backend/src/sync/push/delta.service.ts#L394-L404) | plus session-floor anti-backdate |
| BR-020 billing actions require step-up | ⚠️ Partial | cancel/reactivate/reconcile have `@StepUpAuth` [me-subscription.controller.ts:112-176](../../apps/backend/src/subscription/me-subscription.controller.ts#L112-L176); **checkout/verify do not** L85-109 | Finding P2-b |
| BR-020/§24 roles: owner **or co_owner or accountant** pay; owner/co_owner cancel | ⚠️ Wrong | all billing gated on sole owner `requireOwnedAccountId` [subscription.repository.ts:75-81](../../apps/backend/src/subscription/subscription.repository.ts#L75-L81) | Finding P2-c |
| BR-028 prefill uses user.name/user.phone | ✅ OK | [subscription.repository.ts:229-238](../../apps/backend/src/subscription/subscription.repository.ts#L229-L238) | |
| BR-029 entitlement enforcement strict `<` | ✅ OK | `canCreate` [entitlement.service.ts:41-43](../../apps/backend/src/subscription/entitlement.service.ts#L41-L43) | |
| §3A missing entitlement row → 0/blocked, `value=NULL` → unlimited | ✅ OK | `get()` returns 0 on absent row, `value` otherwise [entitlement.service.ts:30-38](../../apps/backend/src/subscription/entitlement.service.ts#L30-L38); repo returns row-or-null [subscription.repository.ts:87-106](../../apps/backend/src/subscription/subscription.repository.ts#L87-L106) | correctly avoids the `?? Infinity` trap the spec warned about |
| §9 amount server-authoritative from plan_code | ✅ OK | price from `resolvePlanPrice(planCode)` [billing.service.ts:86-92](../../apps/backend/src/subscription/billing.service.ts#L86-L92); webhook amount cross-check [billing.service.ts:170-189](../../apps/backend/src/subscription/billing.service.ts#L170-L189) | |
| §9 verify HMAC signature | ✅ OK | [razorpay-payment.provider.ts:73-78](../../apps/backend/src/subscription/payment/razorpay-payment.provider.ts#L73-L78) (timing-safe) | |
| §9 activation idempotent across verify + webhook | ✅ OK | `claimPaymentEvent` PK=providerRef in same txn [subscription.service.ts:200-201](../../apps/backend/src/subscription/subscription.service.ts#L200-L201), [subscription.repository.ts:389-401](../../apps/backend/src/subscription/subscription.repository.ts#L389-L401) | best-in-class |
| §9 monthly period = 30d; annual = 365d | ✅ OK | [subscription.service.ts:187-189](../../apps/backend/src/subscription/subscription.service.ts#L187-L189) — cycle keyed off `planCode`, not `planFk` | good catch on annual/monthly sharing a planFk |
| §9 webhook signature-only, no step-up | ✅ OK | [razorpay-webhook.controller.ts:24-35](../../apps/backend/src/subscription/razorpay-webhook.controller.ts#L24-L35) `@Public() @SkipThrottle()` | |
| §12 cancel: status stays active, `cancel_at_period_end=true`, idempotent | ✅ OK | atomic CAS [subscription.service.ts:246-270](../../apps/backend/src/subscription/subscription.service.ts#L246-L270) | |
| §12 active+cancel → cancelled at period end (not past_due) | ✅ OK | cron orders cancelled-sweep first [subscription-lifecycle-cron.service.ts:106-108](../../apps/backend/src/subscription/subscription-lifecycle-cron.service.ts#L106-L108); past-due query excludes `cancel_at_period_end=true` [subscription.repository.ts:571](../../apps/backend/src/subscription/subscription.repository.ts#L571) | **resolves the spec's own §12-vs-§19 contradiction correctly** |
| §13 case A reactivate clears flag, no charge | ✅ OK | [subscription.service.ts:279-299](../../apps/backend/src/subscription/subscription.service.ts#L279-L299) | |
| §13 case B re-subscribe via checkout sets `cancel_at_period_end=false` | ❌ **Missing** | `activateFromPayment` patch omits the flag [subscription.service.ts:202-209](../../apps/backend/src/subscription/subscription.service.ts#L202-L209) | **Finding P1** |
| §19 version bump on every transition + cache invalidation | ✅ OK | every write goes through `applyTransition`/`applyTransitionIf` (version++), `transact` invalidates post-commit [subscription.service.ts:337-360](../../apps/backend/src/subscription/subscription.service.ts#L337-L360) | |
| §19 versioned cache key `sub:{acct}:v{n}`, 5-min TTL, no DEL race | ✅ OK | [subscription-cache.ts](../../apps/backend/src/subscription/subscription-cache.ts); guard read [subscription-status.guard.ts:215-262](../../apps/backend/src/auth/mobile/guards/subscription-status.guard.ts#L215-L262) | |
| §19 cron idempotent atomic UPDATE…WHERE, bounded | ✅ OK | `transitionBatch` w/ EvalPlanQual re-check + LIMIT loop [subscription.repository.ts:494-524](../../apps/backend/src/subscription/subscription.repository.ts#L494-L524) | |
| §21 `X-Subscription-Warning` formats | ⚠️ Partial | trialing + past_due only; **`cancelled:ends_at_` missing** [subscription-status.guard.ts:265-275](../../apps/backend/src/auth/mobile/guards/subscription-status.guard.ts#L265-L275) | Finding P3-a |
| §22 `banner_severity`/`show_upgrade_banner` for all 8 states | ❌ **Partial** | only trialing + expired handled; past_due/cancelled/paused/free → `none` [subscription.service.ts:371-383](../../apps/backend/src/subscription/subscription.service.ts#L371-L383) | **Finding P2-a** |
| §7 error contract 402 `subscription_payment_required` / 403 `subscription_suspended` | ✅ OK | guard [subscription-status.guard.ts:144-171](../../apps/backend/src/auth/mobile/guards/subscription-status.guard.ts#L144-L171) | |
| §7/§23 Tier-2 critical mutations live-rechecked at NOW() | ⚠️ Wrong | sync gate applies point-in-time uniformly, no tier distinction [delta.service.ts:364-406](../../apps/backend/src/sync/push/delta.service.ts#L364-L406) | Finding P2-d (spec-version-sensitive) |
| §29.14 critical events → outbox in same txn, drained | ✅ OK | `enqueueOutbox` in txn [subscription.repository.ts:445-454](../../apps/backend/src/subscription/subscription.repository.ts#L445-L454); drainer w/ dead-letter [subscription-lifecycle-cron.service.ts:173-227](../../apps/backend/src/subscription/subscription-lifecycle-cron.service.ts#L173-L227) | |
| §14 downgrade = lock never delete | ✅ OK (evolved) | deferred-reconciliation model; `revokeSlotById`/`lockMany`, nothing deleted [reconciliation.service.ts:195-236](../../apps/backend/src/subscription/reconciliation.service.ts#L195-L236) | model differs from doc — see §7 |

## 3. Findings by severity

### P1 — `cancel_at_period_end` is never cleared on payment activation → paid re-subscription silently self-cancels
- **Where:** [subscription.service.ts:202-209](../../apps/backend/src/subscription/subscription.service.ts#L202-L209) (`activateFromPayment` → `applyTransition` patch).
- **What:** The activation patch sets `status/planFk/planCode/currentPeriodStart/currentPeriodEnd/accessValidUntil` but **not** `cancelAtPeriodEnd`. `expireCancelledAtPeriodEnd` leaves the flag `true` when it flips a row to `cancelled` ([subscription.repository.ts:588-604](../../apps/backend/src/subscription/subscription.repository.ts#L588-L604)), and a pending-cancel `active` row obviously already has it `true`.
- **Failure scenario:** (a) Owner cancels (`active`, `cancel_at_period_end=true`), changes their mind and re-pays via checkout instead of `reactivate`; or (b) a `cancelled` account re-subscribes via checkout (spec §13 case B — which the code itself directs users to, [subscription.service.ts:294](../../apps/backend/src/subscription/subscription.service.ts#L294)). In both, `activateFromPayment` starts a fresh 30/365-day period **but leaves `cancel_at_period_end=true`**. At the new `current_period_end`, `expireCancelledAtPeriodEnd` matches (`status='active' AND cancel_at_period_end=true AND current_period_end<now`) and cancels the subscription the customer just paid for — no renewal, no warning beyond the generic banner. A paying customer loses access.
- **Why it matters:** Silent revenue-affecting data corruption on a core money path; spec §13 case B explicitly lists `cancel_at_period_end=false` as part of the reactivation-via-payment effect.
- **Fix:** Add `cancelAtPeriodEnd: false` to the `applyTransition` patch in `activateFromPayment`. Any successful payment is, by definition, an intent to continue — clearing the flag on every activation is correct for renewals too (harmless no-op when already false).

### P2-a — Banner severity computed for only 2 of 8 spec states
- **Where:** [subscription.service.ts:363-384](../../apps/backend/src/subscription/subscription.service.ts#L363-L384) (`computeBanner`).
- **What:** The `switch` returns a real severity only for `trialing` and `expired`; `active/past_due/cancelled/paused` all fall to `default → {bannerSeverity:'none', showUpgradeBanner:false}`. Spec §22 requires banners for **past_due in grace (warning/critical), cancelled-before-period-end (info), paused (critical), and active-on-free (info)**.
- **Failure scenario:** A past-due account inside its 7-day grace calls `GET /me/subscription` and receives `banner_severity:'none'`, so a client that renders off the payload (rather than the `X-Subscription-Warning` header) shows nothing — the customer never learns they must renew before grace ends. Same blank for a pending-cancel account ("access ends {date}") and a suspended (`paused`) account.
- **Why it matters:** Direct conformance gap on the churn-prevention surface; the header path partially compensates but the payload field is part of the §19 contract and is what the plans/settings screen reads.
- **Fix:** Extend `computeBanner` to cover `past_due` (grace remaining → warning/critical per §22 thresholds), `cancelled` (`cancel_at_period_end` before period end → info), `paused` (critical), and free-plan `active` (info). Note this needs `pastDueGraceUntil`/`cancelAtPeriodEnd`/plan-code, all already on the row.

### P2-b — Checkout & verify skip step-up OTP (spec BR-020 / §9 require it)
- **Where:** [me-subscription.controller.ts:85-109](../../apps/backend/src/subscription/me-subscription.controller.ts#L85-L109) — no `@StepUpAuth`; the controller comment (L42-43, L82-84) records this as a deliberate product decision.
- **What:** Spec §24/BR-020: *"All billing actions require step-up auth (re-verify OTP) even for logged-in users,"* and §9 places step-up before checkout. The code requires step-up on cancel/reactivate/reconcile but not on the two actions that actually move money.
- **Why it matters:** A stolen/borrowed unlocked device can initiate a charge without re-auth. It's not exploitable for theft (money flows to the account's own plan), but it diverges from an explicit, security-relevant spec rule and the divergence lives only in a code comment.
- **Fix (decide):** Either add `@StepUpAuth({ within: '5m' })` to checkout (matching the spec and the rest of the billing surface) or update `docs/backend/subscription.md` §9/§24 to record the product decision. Don't leave spec and code silently contradicting.

### P2-c — All billing actions gated on the sole account owner, excluding co_owner/accountant
- **Where:** `requireOwnedAccountId` checks `accounts.owner_user_fk === userId` [subscription.repository.ts:60-81](../../apps/backend/src/subscription/subscription.repository.ts#L60-L81); used by checkout/verify/cancel/reactivate/reconcile.
- **What:** Spec §24 role matrix: **owner, co_owner, accountant** may upgrade/pay; **owner, co_owner** may cancel/reactivate/choose-stores. The code allows **only** the literal owner for every billing action — co_owners and accountants are locked out entirely.
- **Why it matters:** A functional gap (an accountant can't pay an invoice, a co_owner can't cancel), and a divergence from the documented RBAC contract. It's the *safe* direction (too strict, not too loose), so not urgent — but it's a real behavioural difference from the spec.
- **Fix (decide):** If the product is genuinely single-owner-billing, update §24. Otherwise widen the gate to the role set via the RBAC matrix rather than the `owner_user_fk` shortcut.

### ~~P2-d — Sync write-gate has no Tier-2 live re-check for critical mutations~~ → RESOLVED: conformant to the current sync spec (not a bug)
- **Where:** [delta.service.ts:364-406](../../apps/backend/src/sync/push/delta.service.ts#L364-L406) (`checkSubscription`).
- **Original concern:** the stale `docs/backend/subscription.md` §7/§23 defined a **tiered** offline gate (Tier-2 refund/void/price-override live-rechecked at NOW()); the code applies a uniform point-in-time rule instead.
- **Verified against the current sync spec (`docs/prd/sync-engine.md`):** §20 and the roadmap (line 758) mandate exactly the **uniform point-in-time** gate the code implements — *"server accepts offline sales stamped before `access_valid_until` (`client_modified_at`), rejects later ones (`SUBSCRIPTION_LAPSED_AT_WRITE`) … reuses the §12 point-in-time pattern."* There is **no Tier-1/Tier-2 model** in the current design; the tiered model in `subscription.md` §7/§23 was superseded. The revoked-actor concern is separately covered by the point-in-time permission re-check in `checkGrace` ([delta.service.ts:327-359](../../apps/backend/src/sync/push/delta.service.ts#L327-L359)), and critical actions are `@OnlineOnly` on the client.
- **Outcome:** No code change. The implementation is conformant. This finding was a false positive caused by the outdated `subscription.md` — another data point for the §7 doc-reconciliation action.

### P3-a — `X-Subscription-Warning` omits the `cancelled` case
- **Where:** [subscription-status.guard.ts:265-275](../../apps/backend/src/auth/mobile/guards/subscription-status.guard.ts#L265-L275) (`buildWarning`) — handles `trialing` and `past_due`; spec §21 also lists `cancelled:ends_at_<ISO>` for a pending-cancel account inside its paid period.
- **Fix:** Add a `cancelled` (or `active && cancel_at_period_end`) branch emitting `cancelled:ends_at_<currentPeriodEnd ISO>`. Pairs with P2-a.

### P3-b — `transact` invalidates cache even on a no-op
- **Where:** [subscription.service.ts:343-359](../../apps/backend/src/subscription/subscription.service.ts#L343-L359) — the post-commit `invalidateCache` runs even when `work` returned `null` (already-applied no-op, no version bump). Harmless (best-effort DEL, re-populates identically) but an avoidable Redis round-trip on every idempotent double-tap. Low priority; leave unless the cancel/reactivate no-op path is hot.

## 4. Unwanted / dead / duplicate functionality

- **`razorpaySubId` column is dead.** [schema.ts:468](../../apps/backend/src/db/schema.ts#L468) is written nowhere in the subscription code (grep: only the column definition and the `applyTransition` type union reference it). This codebase has no recurring-subscription webhook — renewals are period-end driven ([subscription.repository.ts:548-579](../../apps/backend/src/subscription/subscription.repository.ts#L548-L579)). Either wire it when Razorpay Subscriptions land or drop it; today it's speculative. **Verify** before removing (a migration/analytics job could read it).
- **`invalidateCache` duplicated** in `SubscriptionService` and `ReconciliationService`. This one is **justified and documented** — [reconciliation.service.ts:83-94](../../apps/backend/src/subscription/reconciliation.service.ts#L83-L94) explains the circular-provider-graph reason (`SubscriptionService.activateFromPayment` calls into `ReconciliationService.autoRestore`). Both delegate to the shared `subVersionPointerKey`, so there's no key-scheme drift. Leave as-is.
- **`stampHeaders` duplicated** between guard and interceptor — also justified: the guard-throws path can't reach the interceptor ([subscription-status.guard.ts:130-137](../../apps/backend/src/auth/mobile/guards/subscription-status.guard.ts#L130-L137)). Correct duplication.
- No dead branches or unreferenced endpoints found in the module.

## 5. Real-time / scenario issues

Walked the §4 catalogue against the code:
- **Concurrency (activation vs reconcile):** handled — canonical `accounts → account_subscriptions` lock order in both `activateFromPayment` ([subscription.service.ts:198](../../apps/backend/src/subscription/subscription.service.ts#L198)) and `DowngradeDetectionService.isOverLimit` ([downgrade-detection.service.ts:52](../../apps/backend/src/subscription/downgrade-detection.service.ts#L52)); reconcile/swap/apply all lock-then-read ([reconciliation.service.ts:183-189](../../apps/backend/src/subscription/reconciliation.service.ts#L183-L189), L307-311).
- **Retry / at-least-once (double webhook + verify):** idempotent via `processed_payment_events` PK claim in-txn. ✅
- **Partial failure:** transition + outbox + reconciliation restore all in one UoW; cache DEL is deliberately post-commit. ✅
- **Cron double-run / mass same-day expiry:** Redis lock (TTL 900s > cadence) + bounded `LIMIT` loop + EvalPlanQual predicate re-check. ✅
- **Abandonment (checkout never completes):** durable `payment_orders` row + Redis order key; late webhook falls back to the durable row after Redis TTL ([billing.service.ts:209-221](../../apps/backend/src/subscription/billing.service.ts#L209-L221)). ✅
- **Trust boundary:** HMAC timing-safe compare, amount cross-check, server-authoritative plan/price, raw-body signature capture. ✅
- **Dependency failure (Razorpay down):** 8s per-attempt timeout, 3-attempt bounded retry on 5xx/network, normalized to 503 ([razorpay-payment.provider.ts:172-201](../../apps/backend/src/subscription/payment/razorpay-payment.provider.ts#L172-L201)). ✅
- **The one that fails:** **stale-flag renewal** — the P1 `cancel_at_period_end` scenario. A decision (renew) made while a stale flag says "cancel" produces the wrong terminal state.

## 6. Missing / enterprise-grade gaps (right-sized)

- **Should add:** banner coverage (P2-a) and the cancelled warning header (P3-a) — small, spec-required.
- **Deferred (fine for now, note the trigger):**
  - Recurring-charge webhook / Razorpay Subscriptions — today renewals rely on period-end→past_due; fine until auto-renew is a product requirement. Trigger: `razorpaySubId` gets a writer.
  - Signed `access_valid_until` token (spec §23 Rec7) — already tracked as planned in comments; client gate is UX-only, server sync gate is authoritative. Acceptable.
  - Outbox "pending > 5 min" alert (spec item 38) — dead-letter + logs exist ([subscription-lifecycle-cron.service.ts:213-217](../../apps/backend/src/subscription/subscription-lifecycle-cron.service.ts#L213-L217)); a metric/alert on queue age would complete it.

## 7. Wrong decisions / structure to re-decide

- **The authoritative spec is stale, not the code.** `docs/backend/subscription.md` describes a **synchronous** downgrade (§14: pick stores → force sync → pay → lock, all in one request) with **no `reconciliation_status`**. The code implements a **deferred** model: a plan change sets `reconciliation_status='pending'`, blocks all writes account-wide, and the owner resolves later via `POST /me/subscription/reconciliation` (+ a `swap` flow + `autoRestore` on re-upgrade). The deferred model is **the better design** (it never forces a destructive choice inside the payment request, it's fully reversible, and it survives the offline case via `reconciliation_effective_at`), and it's implemented cleanly. **The action here is documentation, not code:** update `docs/backend/subscription.md` §14/§15/§19 to describe the reconciliation model, so the next reviewer isn't checking against a spec the team already superseded. Until then, every "conform to §14" check is against dead text.
- **No genuine wrong-fork found in the code itself** — the forks that matter (idempotency in-txn vs ambient flag; post-commit cache DEL; lock-then-read; cycle keyed off planCode not planFk) are all resolved the correct way, and the comments show the alternatives were considered.

## 8. Over-engineering to simplify

Very little. The design is right-sized for a money path. Candidates, all minor:
- The **no-op cache invalidation** (P3-b) is a tiny excess round-trip, not structural.
- `razorpaySubId` (§4) is speculative-until-used; drop or wire.

Nothing warrants a queue/saga-to-transaction downgrade or an abstraction removal — the payment-provider port is a real two-implementation seam (Razorpay + Fake), the outbox is load-bearing for audit durability, and the versioned cache is genuinely needed.

## 9. What's done well (preserve)

- **In-transaction idempotency claim** (`processed_payment_events` PK + `ON CONFLICT DO NOTHING` in the activation txn) — the textbook-correct fix, and the comments explain exactly why the removed Redis-flag approach was unsafe ([subscription.service.ts:165-238](../../apps/backend/src/subscription/subscription.service.ts#L165-L238)).
- **Outbox audit** with bounded retry + dead-letter, drained in the same txn as the `processed_at` stamp ([subscription-lifecycle-cron.service.ts:195-207](../../apps/backend/src/subscription/subscription-lifecycle-cron.service.ts#L195-L207)).
- **Versioned cache key** eliminating the delete-vs-write race by construction ([subscription-cache.ts](../../apps/backend/src/subscription/subscription-cache.ts)).
- **Cron correctness**: bounded batches, EvalPlanQual re-validation, canonical lock order, cancelled-before-past-due ordering that fixes the spec's own contradiction.
- **Self-lockout guards** in reconcile + swap that correctly treat the current physical device as potentially multi-slot (ANY-reachable, not first-found) ([reconciliation.service.ts:510-536](../../apps/backend/src/subscription/reconciliation.service.ts#L510-L536)).
- **Exhaustive-switch guard status gate** — adding a status is a compile error, not a silent open gate ([subscription-status.guard.ts:144-165](../../apps/backend/src/auth/mobile/guards/subscription-status.guard.ts#L144-L165)).
- **Production safety**: refusing to bind the Fake provider in prod ([subscription.module.ts:49-53](../../apps/backend/src/subscription/subscription.module.ts#L49-L53)).

## 10. Recommended changes, ranked

1. ✅ **DONE (P1):** added `cancelAtPeriodEnd: false` to the `activateFromPayment` patch — [subscription.service.ts:202-215](../../apps/backend/src/subscription/subscription.service.ts#L202-L215).
2. ✅ **DONE (P2-a):** extended `computeBanner` to past_due/cancelled/paused/free per §22 — [subscription.service.ts:362-408](../../apps/backend/src/subscription/subscription.service.ts#L362-L408).
3. ✅ **RESOLVED (P2-d):** sync gate is conformant to the current spec (`sync-engine.md` §20) — no change; see finding above.
4. **DECIDE (P2-b):** checkout/verify step-up — add `@StepUpAuth` or amend §9/§24.
5. **DECIDE (P2-c):** billing RBAC scope — widen to co_owner/accountant or amend §24.
6. **ADD (P3-a):** `cancelled:ends_at_` warning header — [subscription-status.guard.ts:265-275](../../apps/backend/src/auth/mobile/guards/subscription-status.guard.ts#L265-L275).
7. **DOC:** update `docs/backend/subscription.md` §14/§15/§19 to the deferred-reconciliation model the code actually implements, and delete the superseded §7/§23 tiered sync-gate text.
8. **REMOVE/WIRE:** `razorpaySubId` dead column — [schema.ts:468](../../apps/backend/src/db/schema.ts#L468).
