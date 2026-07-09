# QA Test Cases — Sync Push (`POST /stores/:storeId/sync/delta`)

> Offline-first sync engine, push path: mobile devices submit locally-made (offline) mutations to the
> server. Analyzed from the actual implementation (QA mode) cross-referenced against the PRD
> (`docs/prd/sync-engine.md`, §9–§13, §20, BR-SYNC-001…025). Where the code has already fixed a gap the
> PRD still flags (e.g. dependency-sorted cascade), the **code is treated as ground truth**; deltas from
> the PRD are called out explicitly.

**Files reviewed:**
`apps/backend/src/sync/push/delta.service.ts`, `master-data.handler.ts`, `mutation-handler.registry.ts`,
`mutation.types.ts`, `handlers/{customer,lookup,payment-account,product,supplier}.handler.ts`,
`handlers/payload-helpers.ts`, `dto/sync-delta.schema.ts`, `dto/response/conflict.response.ts`,
`guards/{device-slot,sync-rate-limit}.guard.ts`, `mappers/response/conflict.response-mapper.ts`,
`sync.constants.ts`, `sync.controller.ts`, `services/sync-conflict.service.ts`,
`repositories/{sync-idempotency,sync-mutation-failure,sync-conflict,tombstone}.repository.ts`,
`auth/mobile/guards/subscription-status.guard.ts`, `common/rbac/guards/{tenant,permissions}.guard.ts`,
`common/rbac/rbac.repository.ts` (`wasCrudAuthorizedAt`), `common/error-codes.ts`,
`test/integration/sync/sync-engine.spec.ts` (existing coverage baseline).

---

## 1. Feature understanding (BA)

### What it does
`POST /stores/:storeId/sync/delta` is the combined **push + pull** endpoint. In one round trip a device:
1. submits up to 100 locally-queued **mutations** (create/update/delete against reference data), and
2. receives per-mutation outcomes **plus** the next page of server-side changes (upserts/tombstones)
   since its `sync_cursor`.

Always returns **HTTP 200**; every mutation's success/failure is carried per-item in `mutation_results`
(a 5xx is reserved for whole-call abort scenarios — see F6/F10).

### Actors
- **Mobile device / cashier app** — submits the batch, offline-generated `mutation_id` (ULID) per
  mutation, guuid-keyed payloads.
- **Server (`SyncDeltaService`)** — preflight-validates, dispatches to a per-entity handler, records
  idempotency + conflicts, returns results.
- **Other devices in the same store** — see the effects via their own next `/sync/changes` pull
  (tombstones/upserts), and via `GET /sync/conflicts` for anything that landed as a conflict.

### Entities actually writable today
Only **6 mutation handlers are registered**: `customer`, `lookup`, `product`, `product_case`,
`paymentaccount`, `supplier` — all **master/reference data**, all using the same
`MasterDataSyncHandler` optimistic-lock primitive. `store`, `unit`, `taxrate`, `payment_method`,
`store_device_access`, `staff` are pull-only (no push handler). **`order`/`shift`/`cash`/`stock` do not
exist as mutation handlers at all** — pushing any of them is a clean `UNKNOWN_MUTATION` rejection, not a
crash. This is a deliberate, documented gap (PRD §3/§13/§22 S-2): the transactional/event-sourced write
model for sales/stock is **not built**; only the optimistic-lock master-data model is live. All
concurrency/conflict testing below is scoped to that model.

### Inputs / outputs
**Request** (`SyncDeltaSchema`): `sync_cursor?`, `permissions_version?`, `supported_entity_types?`,
`mutations[]` (max 100), each `{ mutation_id (ULID), entity_type (free string), action
(create|update|delete), payload (free record), expected_row_version? (required for update),
client_modified_at? (ISO w/ offset), parent_guuid? }`.

**Response**: `mutation_results[]` (one of `applied | duplicate | rejected | retry_later | conflict`),
`changes`, `sync_cursor`, `has_more`, `server_time`, `permissions_version`, optional
`snapshot`/`snapshot_signature`.

### Business rules / invariants extracted from code
- **BR-1 (optimistic lock):** every `update` **requires** `expected_row_version`; the handler does a
  single version-gated `UPDATE … WHERE row_version = expected` (no read-then-write TOCTOU). Zero rows
  updated ⇒ fetch the live row to disambiguate: gone (`NOT_FOUND`), soft-deleted (`NOT_FOUND`, different
  message), or alive-but-stale (`conflict` with the live `server_row`).
- **BR-2 (idempotency, same-tx):** the idempotency row is written in the **same transaction** as the
  business write — a crash between them is architecturally impossible. A replayed `mutation_id` returns
  the cached result as `duplicate` without re-running the handler.
- **BR-3 (per-mutation transaction isolation):** one mutation's transaction (a Postgres SAVEPOINT nested
  inside the batch's outer tx) failing never rolls back siblings.
- **BR-4 (dependency-sorted, wave-based concurrency):** mutations are topologically sorted by
  `parent_guuid` and grouped into "waves" — same-entity-guuid mutations and parent→child pairs always
  land in strictly increasing waves; unrelated mutations in the same wave run concurrently
  (`WAVE_CONCURRENCY = 4`). This is **already fixed** relative to the PRD's S-3 flag (which describes an
  order-dependent, non-topo-sorted cascade) — verify this fix holds under adversarial batch ordering
  (C5/C6 below).
- **BR-5 (cascade-fail):** a mutation whose `parent_guuid` is in this request's `failedGuuids` set is
  rejected `PARENT_FAILED` without running its handler. `failedGuuids` includes both freshly-rejected
  mutations **and** mutations that replay as `duplicate` with a cached `rejected` status (S-3b fix) — but
  only for guuids that appear **in this same batch** (see PUSH-EDGE-08, a real remaining gap).
- **BR-6 (point-in-time grace, §12):** a write denied by *current* permissions may still be honored if
  the user was authorized at `client_modified_at` — subject to a 3-layer defense: (a) reject if
  `client_modified_at` is >5 min in the future, (b) reject if it predates the device session, (c) cap how
  far back the check reaches to `now − 30 min` (`REVOCATION_GRACE_WINDOW_MS`) regardless of how old the
  mutation honestly is.
- **BR-7 (skew clamp ≠ grace clock check):** the *base* preflight clamps a clock-fast device's
  `client_modified_at` to server-now and **applies the mutation** (never rejects for honesty) — this is
  a **different, more lenient** mechanism than the grace-path's strict ±5-min future check, which only
  runs when current-permission authorization has already failed. Conflating the two is a likely source of
  test/dev confusion (O2 vs O3 below).
- **BR-8 (subscription write-gate, §20):** transient states (`paused`, no subscription row,
  `reconciliation pending` outside its own effective-date grace) return **uncached** `retry_later` (the
  client must keep the mutation queued, never roll it back); a **deterministic** post-lapse write
  (`client_modified_at` after `access_valid_until`, evaluated with its own session-floor) is a **cached,
  terminal** `SUBSCRIPTION_LAPSED_AT_WRITE` rejection.
- **BR-9 (poison cap):** a handler crash bumps a failure counter (survives its own rolled-back tx); at 7
  the mutation is terminally, cache-rejected `SERVER_ERROR` without ever running the handler again.
- **BR-10 (guuid permanence):** a `guuid` is unique at the DB level regardless of soft-delete state — you
  cannot re-create a new row under a guuid that was ever used, even after that row was deleted.
- **BR-11 (lookup protections):** `isSystem` lookup rows can't be updated/deleted (`LOOKUP_VALUE_PROTECTED`);
  global (`store_fk IS NULL`) lookup rows are simply unreachable through the store-scoped `WHERE` and read
  back as `NOT_FOUND` rather than "forbidden".
- **BR-12 (conflict_type tagging):** every non-`applied` outcome should carry a `conflict_type` of
  `VALIDATION | BUSINESS_RULE | MASTER_DATA` so the client routes UX correctly (verified per call site —
  one inconsistency found, see PUSH-UX-01).

### State machine (per mutation, per attempt)
```
                 ┌─ idempotency hit (live) ───────────────► duplicate
                 │
new mutation ────┼─ payload > 64KB ───────────────────────► rejected (VALIDATION, cached)
                 ├─ poison count ≥ 7 ────────────────────────► rejected (BUSINESS_RULE, cached)
                 ├─ parent in failedGuuids ─────────────────► rejected PARENT_FAILED (cached)
                 ├─ no handler for entity_type ─────────────► rejected UNKNOWN_MUTATION (cached)
                 ├─ update w/o expected_row_version ─────────► rejected SYNC_MISSING_ROW_VERSION (cached)
                 ├─ not authorized (now or grace) ───────────► rejected PERMISSION_DENIED (cached)
                 ├─ subscription transient block ────────────► retry_later (NOT cached)
                 ├─ subscription lapsed at write-time ───────► rejected SUBSCRIPTION_LAPSED_AT_WRITE (cached)
                 └─ execute handler ──┬─ HandlerRejectedSignal ─► rejected (cached, code varies)
                                      ├─ conflict (stale version) ─► conflict (cached, MASTER_DATA)
                                      ├─ applied ───────────────► applied (cached)
                                      ├─ idempotency race lost ──► poll winner → duplicate, or 503 (whole call aborts)
                                      └─ unexpected crash ───────► rejected SERVER_ERROR (UNCACHED, poison++)
```

### Assumptions flagged (confirm with product/dev — see §7 Open questions)
- A1: `entity_type` is deliberately a free string (not an enum) at the schema layer so one unknown
  entity never 400s the whole batch — confirmed intentional via code comment.
- A2: The 30-minute grace-window cap (BR-6c) is read as *intentionally* stricter than "however old the
  mutation honestly is" — i.e., a device offline for 3 hours with a since-revoked user genuinely loses
  grace protection past the 30-minute mark. Treating this as designed behavior, not a bug, pending
  confirmation (see Q1).
- A3: `PATCH /sync/conflicts/:mutationId` gates on the entity's `view` permission only (not `edit`, not
  original-submitter ownership) — treating as intentional ("manager resolves a cashier's conflict")
  pending confirmation (see Q2).
- A4: The `money`/`quantity` numeric-input branch skipping the digit/decimal-place cap that the
  string-input branch enforces is treated as an **unintended validation gap**, not a designed asymmetry
  (see PUSH-NEG-11/12, Q3).

---

## 2. Coverage plan

| Dimension | Applies? | Approx. cases |
|---|---|---|
| Happy paths | Yes | 9 |
| Business rules (satisfied + violated) | Yes — the core of this module | 13 pairs (~24 cases) |
| Boundaries | Yes | 12 |
| Negative / invalid | Yes | 13 |
| Failure & recovery | Yes — retries, races, poison, whole-call abort | 11 |
| Concurrency | Yes — **CRITICAL**, the primary reason this module was targeted | 10 |
| Permissions / roles | Yes | 7 |
| State transitions | Yes | 7 |
| Cross-cutting (offline/sync, tenancy, time) | Yes | 7 |
| UX (response-shape correctness for client routing) | Yes (server-side proxy for UX) | 2 |
| §5 edge-case checklist | Yes — dedicated section 4 | 10 |

Total: **~112 concrete cases** (many rule cases are satisfied+violated pairs counted together above).

---

## 3. Test cases

### 3.1 Happy paths (Area: happy)

**PUSH-HAPPY-01 — Create a customer, no FK fields**
Criticality: High · Traces to: BR-1 create path
Preconditions: Store `S1`; user has `Customer:create`; device has an active slot.
Input: `{mutation_id: ULID, entity_type:'customer', action:'create', payload:{guuid: uuid4(), name:'Meena Traders', phone:'9876500000'}}`
Steps: POST `/stores/S1/sync/delta` with the single mutation.
Expected result: `mutation_results[0] = {status:'applied', entity_id, entity_guuid, row_version:1, data:{...}}`; a `customers` row exists with `store_fk=S1`, `created_by=user`.
Notes: verify `data` echoes snake_case wire keys via `wireRow`.

**PUSH-HAPPY-02 — Create a product with all three FK resolvers populated**
Criticality: High · Traces to: create + `resolveFks`
Preconditions: `unit`, `taxrate`, and a `category` lookup already exist in `S1` (or globally for the lookup).
Input: product create payload with `unit_guuid`, `taxrate_guuid`, `category_lookup_guuid` all set to real guuids, `selling_price:'199.00'`.
Expected: `applied`; product row has `unit_fk`/`taxrate_fk`/`category_lookup_fk` correctly resolved to internal ids (not guuids).

**PUSH-HAPPY-03 — Partial update touches only sent fields**
Criticality: High · Traces to: BR-1 update + `prune`
Preconditions: Existing customer row_version=1.
Input: `{action:'update', payload:{guuid, phone:'9998887777'}, expected_row_version:1}` (name/email omitted).
Expected: `applied`, `row_version:2`; `name`/`email` unchanged in DB; only `phone` + `updated_by` + `row_version` touched.

**PUSH-HAPPY-04 — Soft-delete (deletedAt mode) writes a tombstone**
Criticality: Critical · Traces to: BR-2/tombstone same-tx write
Preconditions: Existing supplier.
Input: `{action:'delete', payload:{guuid}}`.
Expected: `applied`; `suppliers.deleted_at` set, `deleted_by` = user; a `sync_tombstones` row for `(supplier, guuid)` exists in the **same transaction**; another device's next `/sync/changes` receives it as a delete.

**PUSH-HAPPY-05 — Soft-delete (isActive mode) for lookup**
Criticality: High · Traces to: BR-1 delete + isActive deleteMode
Input: delete a non-system lookup value.
Expected: `applied`; `lookup.is_active=false` (row still physically present); tombstone written.

**PUSH-HAPPY-06 — Independent mutations across entities run concurrently in one wave**
Criticality: Medium · Traces to: BR-4 `computeWaves`
Input: batch of 4 mutations: create customer, create supplier, create product (no FK), create paymentaccount — none share a guuid or parent_guuid.
Expected: all `applied`; all placed in wave 0 and executed via `runBounded` (≤4 concurrent); response order matches `mutations` array order regardless of completion order.

**PUSH-HAPPY-07 — Parent-then-child in one batch, submitted in dependency order**
Criticality: High · Traces to: BR-4 topoSort/waves + FK resolution
Input: `[{action:'create', entity_type:'product', payload:{guuid:P}}, {action:'create', entity_type:'product_case', payload:{guuid:C, product_guuid:P, parent_guuid:P... }, parent_guuid:P}]`.
Expected: product create lands in wave 0, product_case in wave 1 (its `product_guuid` FK resolves because the product committed in the prior wave); both `applied`.

**PUSH-HAPPY-08 — Combined push+pull in one call**
Criticality: High · Traces to: §9 combined endpoint
Input: a valid `sync_cursor` from a prior pull + one create mutation.
Expected: response contains both `mutation_results` (for the pushed mutation) **and** a populated `changes`/`sync_cursor`/`has_more` for anything changed since that cursor — a single round trip serves both directions.

**PUSH-HAPPY-09 — Stale permissions_version triggers snapshot piggyback**
Criticality: Medium · Traces to: permission-freshness contract
Input: request with `permissions_version` older than the server's current value.
Expected: response includes `snapshot` + `snapshot_signature`; `permissions_version` in the response is the server's current value.

---

### 3.2 Business rules — satisfied & violated (Area: rule)

**PUSH-RULE-01a/b — Optimistic lock required for update**
Criticality: Critical · Traces to: BR-1, BR-SYNC-009
- (a) satisfied: update with correct `expected_row_version` → `applied`, version increments by exactly 1.
- (b) violated: update with `expected_row_version` omitted → `rejected SYNC_MISSING_ROW_VERSION` (VALIDATION, cached) — handler never invoked.

**PUSH-RULE-02a/b — Stale version → conflict, not silent overwrite**
Criticality: Critical · Traces to: BR-1, BR-SYNC-009
- (a) satisfied: `expected_row_version` matches current DB value → `applied`.
- (b) violated: `expected_row_version` is one behind current → `conflict` with `conflict_type:'MASTER_DATA'`, `server_row` = the live row (fresh values, fresh row_version), and a row written to `sync_conflicts` retrievable via `GET /sync/conflicts`. Original payload is **never applied**.

**PUSH-RULE-03a/b — RBAC current-permission gate**
Criticality: Critical · Traces to: BR-6
- (a) satisfied: user has `<Entity>:create/edit/delete` → proceeds past authorization.
- (b) violated, no grace available (no `client_modified_at` sent): `rejected PERMISSION_DENIED` — message "not authorized (no queue-time timestamp for grace)", BUSINESS_RULE.

**PUSH-RULE-04a/b — Point-in-time grace after mid-session revocation**
Criticality: Critical · Traces to: BR-6, PRD §12 (the engine's strongest section)
- (a) satisfied: role had the permission at `client_modified_at` (e.g. queued 10 min ago), current role lacks it (revoked 5 min ago), `client_modified_at` ≥ `sessionCreatedAt`, within the 30-min grace floor → `applied` (grace honored — a sale/edit rung before revocation still lands).
- (b) violated: same setup but role was revoked **more than 30 minutes before `now`**, and the mutation's own `effectiveAsOf` is also older than `now − 30min` → `rejected PERMISSION_DENIED`, "not authorized (revoked before this write was queued)" — **even though the user WAS genuinely authorized when they queued it**. See PUSH-EDGE / A2 — this is the grace-window cap (BR-6c) biting a legitimately-old offline edit; assert this exact (intentional-per-code) behavior, don't assume it's a bug without product sign-off.

**PUSH-RULE-05a/b — Future-dated grace attempt (backdating defense)**
Criticality: Critical · Traces to: BR-6a
- (a) satisfied: `client_modified_at` within `now ± 5min` → grace check proceeds normally.
- (b) violated: `client_modified_at` = `now + 10min` and current permission check has already failed → `rejected PERMISSION_DENIED`, "not authorized (client_modified_at is in the future)" — closes the "forge a future timestamp to smuggle in a since-revoked write" hole.

**PUSH-RULE-06a/b — Mutation can't predate its own device session**
Criticality: High · Traces to: BR-6b
- (a) satisfied: `client_modified_at` ≥ device session's `created_at`.
- (b) violated: `client_modified_at` is before the session was created (e.g., a stale queued item from a previous, already-superseded session tries to piggyback on a new session's grace) → `rejected PERMISSION_DENIED`, "not authorized (mutation predates its device session)".

**PUSH-RULE-07a/b — Subscription point-in-time write-gate**
Criticality: Critical · Traces to: BR-8, BR-SYNC-020-adjacent, PRD §20
- (a) satisfied: `client_modified_at` before `access_valid_until` → `applied` even though the subscription has since lapsed.
- (b) violated: `client_modified_at` after `access_valid_until` (and after the session floor) → `rejected SUBSCRIPTION_LAPSED_AT_WRITE` (BUSINESS_RULE, cached/deterministic — a later renewal cannot retro-authorize it).

**PUSH-RULE-08a/b — Subscription transient states never terminally reject**
Criticality: Critical · Traces to: BR-8
- (a) `status='paused'` → `retry_later` (`SUBSCRIPTION_SUSPENDED`), **not cached**.
- (b) `reconciliation_status='pending'` and the mutation's `effectiveAsOf` is NOT before `reconciliation_effective_at` → `retry_later` (`SUBSCRIPTION_RECONCILIATION_REQUIRED`), not cached. Confirm: retrying the identical mutation_id a second time re-evaluates fully (no stale cache), and once the pending state clears, the same mutation_id applies cleanly.

**PUSH-RULE-09a/b — Poison-mutation cap**
Criticality: High · Traces to: BR-9, S-7 (PRD-flagged as previously missing — now present)
- (a) satisfied: failure count < 7 → handler re-attempted on each retry.
- (b) violated: failure count reaches 7 (via 7 genuine handler crashes) → 8th attempt: `rejected SERVER_ERROR` (BUSINESS_RULE, cached) **without invoking the handler** — verify via a spy/log that the handler is never called on this attempt.

**PUSH-RULE-10a/b — Parent-cascade**
Criticality: Critical · Traces to: BR-5, BR-SYNC-007 note, PRD S-3 (partially fixed)
- (a) satisfied: parent applies in wave 0 → child (parent_guuid = parent's guuid) applies in wave 1.
- (b) violated: parent's create is rejected (e.g. duplicate guuid) in wave 0 → child in wave 1 gets `rejected PARENT_FAILED` without its own handler running, and — per S-3b fix — the child's own guuid is added to `failedGuuids` so a grandchild in wave 2 also cascades.

**PUSH-RULE-11a/b — Lookup `isSystem` protection**
Criticality: High · Traces to: BR-11
- (a) satisfied: update/delete a non-system lookup value → proceeds.
- (b) violated: update or delete a lookup row with `is_system=true` → `rejected LOOKUP_VALUE_PROTECTED` (BUSINESS_RULE) for **both** verbs; confirm **create** of a new lookup is never blocked by this guard (guard only runs on update/delete) and that a client cannot set `is_system` via the create payload (field isn't in the schema).

**PUSH-RULE-12a/b — Per-mutation payload cap**
Criticality: Medium · Traces to: BR-SYNC-012 (S-36)
- (a) satisfied: payload ≤ 64KB serialized → proceeds.
- (b) violated: payload > 64KB (e.g. an oversized `details` JSON blob on a paymentaccount) → `rejected MUTATION_PAYLOAD_TOO_LARGE` (VALIDATION, cached) **before** idempotency-live-record short-circuits future retries with the same mutation_id — i.e. retrying the identical oversized payload just replays the cached rejection, doesn't re-measure.

**PUSH-RULE-13a/b — Device slot entitlement gates the whole call**
Criticality: High · Traces to: guards/device-slot.guard.ts
- (a) satisfied: device has claimed `POST /stores/:id/access` → push proceeds.
- (b) violated: device has no active slot → `403 DEVICE_SLOT_REQUIRED` at the **guard layer**, before any mutation is parsed/processed — verify **zero** mutations from the batch are applied (no partial processing).

---

### 3.3 Boundaries (Area: boundary)

**PUSH-BOUND-01 — Batch size at the cap**
Criticality: Medium · Input: exactly 100 mutations. Expected: accepted, all processed.

**PUSH-BOUND-02 — Batch size over the cap**
Criticality: Medium · Input: 101 mutations. Expected: whole request `400` (Zod `max(100)`) — **zero** mutations applied, distinct from a per-mutation rejection.

**PUSH-BOUND-03 — Payload exactly at 64KB vs 64KB+1 byte**
Criticality: Medium · Traces to: PUSH-RULE-12. Expected: at-limit accepted; limit+1 byte → `MUTATION_PAYLOAD_TOO_LARGE`.

**PUSH-BOUND-04 — `money` string form: 2 decimals ok, 3 decimals rejected**
Criticality: High · Input: `selling_price:'19.99'` vs `'19.999'`. Expected: `'19.99'` applied; `'19.999'` → `VALIDATION_FAILED` (regex fails).

**PUSH-BOUND-05 — `quantity` string form: 3 decimals ok, 4 rejected**
Criticality: Medium · Input (product_case): `quantity:'12.345'` vs `'12.3456'`. Expected: 3dp applied; 4dp `VALIDATION_FAILED`.

**PUSH-BOUND-06 — `name` field length: 200 chars ok, 201 rejected**
Criticality: Low · Applies to customer/product/supplier `name` (`max(200)`), lookup `label` (`max(80)`)/`description` (`max(200)`). Expected: at-limit accepted, limit+1 `VALIDATION_FAILED`.

**PUSH-BOUND-07 — `expected_row_version` must be a positive integer**
Criticality: High · Input: `expected_row_version: 0` and `-1`. Expected: schema `positive()` rejects both at the **whole-request** level (400) — a client bug sending `0` for "brand-new local row" (instead of omitting it for create, or the real version for update) fails loudly, not silently.

**PUSH-BOUND-08 — Future-skew tolerance exactly at 5 minutes**
Criticality: High · Traces to: PUSH-RULE-05. Input: `client_modified_at = now + 5min` (at threshold, uses `>` so should still pass) vs `now + 5min + 1s`. Expected: at-threshold passes the grace future-check; over it is denied. Confirm the exact comparison operator (`>`, strictly-greater) so the boundary itself is inclusive of "still OK".

**PUSH-BOUND-09 — Revocation grace window exactly at 30 minutes**
Criticality: High · Traces to: PUSH-RULE-04. Input: revoke timestamp / mutation age straddling `now − 30min`. Expected: verify the exact clamp boundary (`graceFloor = now - 30min`); a mutation whose `effectiveAsOf` is exactly at the floor vs 1 second older produces different grace outcomes — pin down the boundary explicitly rather than assuming.

**PUSH-BOUND-10 — `mutation_id` ULID format strictness**
Criticality: High · Input: a 25-char, a 27-char, and a lowercase-with-invalid-char ULID. Expected: **any** malformed `mutation_id` anywhere in the array 400s the **entire request** (array-level Zod validation) — unlike `entity_type`, which is deliberately loose per-item. Confirm this asymmetry explicitly: a single bad mutation_id blocks 99 otherwise-good mutations in the same call.

**PUSH-BOUND-11 — `client_modified_at` requires a timezone offset**
Criticality: Medium · Input: `"2026-07-08T10:00:00"` (no offset) vs `"2026-07-08T10:00:00+05:30"`. Expected: no-offset form fails `z.iso.datetime({offset:true})` → whole request 400; offset form accepted.

**PUSH-BOUND-12 — `money`/`quantity` numeric-input digit cap is NOT enforced (asymmetry)**
Criticality: High · Traces to: `payload-helpers.ts` `money`/`quantity` unions; DB columns `numeric(12,2)`/`numeric(12,3)`.
Input: `selling_price: 12345678901.23` (11 integer digits) sent as a **JSON number**, vs the same value sent as a **string** `"12345678901.23"`.
Expected (actual, verify): the **string** form is rejected client-side-visibly as `VALIDATION_FAILED` (regex caps at 10 integer digits). The **number** form passes Zod (`z.number().nonnegative().finite()` has no digit-count check), gets `.toFixed(2)`'d, and is handed to Postgres — which then throws a `numeric field overflow` (Postgres code `22003`), **not** one of the two codes `mapConstraintViolation` understands (`23505`/`23503`) → falls through to the generic crash handler → **uncached `SERVER_ERROR`**, bumps the poison counter, logged as an "internal error" even though it's 100% a client input problem.
Notes: this is a real validation gap (not just a boundary curiosity) — flag prominently, see Q3 and PUSH-NEG-11/12.

---

### 3.4 Negative / invalid (Area: negative)

**PUSH-NEG-01 — Unknown entity_type**
Criticality: High · Input: `entity_type:'gizmo'`. Expected: `rejected UNKNOWN_MUTATION` (VALIDATION) for **that mutation only**; rest of the batch still processes. Traces to: A1/BR-SYNC dispatcher note.

**PUSH-NEG-02 — Known-but-not-yet-pushable entity_type**
Criticality: Critical (surfaces the #1 documented gap) · Input: `entity_type` ∈ {`order`, `shift`, `stock_event`, `staff`, `store`, `unit`, `taxrate`, `payment_method`, `store_device_access`}. Expected: `rejected UNKNOWN_MUTATION` for all of these — confirms no accidental partial/unsafe handling exists for POS-transactional types that must NOT use the optimistic-lock model if/when added.

**PUSH-NEG-03 — Invalid `action` value**
Criticality: Medium · Input: `action:'upsert'`. Expected: whole request 400 (Zod enum) — not a per-mutation rejection.

**PUSH-NEG-04 — Missing required field in create payload**
Criticality: High · Input: customer create without `name`. Expected: per-mutation `VALIDATION_FAILED`, message lists the offending field(s) (up to 5, joined).

**PUSH-NEG-05 — Wrong type in payload field**
Criticality: Medium · Input: `credit_limit: true` (boolean, not money). Expected: `VALIDATION_FAILED`.

**PUSH-NEG-06 — `expected_row_version` explicitly `null` on update**
Criticality: Medium · Input: `{action:'update', expected_row_version: null, ...}`. Expected: same as omitted → `SYNC_MISSING_ROW_VERSION` (the `== null` check catches both `undefined` and `null`).

**PUSH-NEG-07 — Create with a non-UUID `guuid`**
Criticality: Medium · Input: `payload.guuid:'not-a-uuid'`. Expected: `VALIDATION_FAILED` from the handler's own `createSchema` (outer request schema allows any string in `payload`, so this must be caught at the handler layer — verify it is, not silently coerced).

**PUSH-NEG-08 — Delete payload missing `guuid`**
Criticality: Medium · Input: `{action:'delete', payload:{}}`. Expected: `VALIDATION_FAILED`, "delete payload requires guuid" — this path is a manual check in `remove()`, not Zod; verify it's actually reached (no schema validation runs before it for delete).

**PUSH-NEG-09 — Update payload attempts to change an immutable field (lookup `code`/`lookup_type_code`)**
Criticality: Medium · Input: lookup update payload with `code:'NEW_CODE'` included. Expected: **silently ignored** — `updateSchema` for lookup excludes `code`/`lookup_type_code`, and Zod `z.object()` strips unrecognized keys by default, so the field is dropped with **no error and no warning**. Verify DB `code` is unchanged after this call and the response doesn't hint at the ignored field. Note: a client bug that believes it changed `code` gets silent no-op, not a rejection — flag as a UX/diagnostics gap (see Q4).

**PUSH-NEG-10 — Cross-store FK reference (tenant isolation on FK resolution)**
Criticality: Critical · Traces to: BR-SYNC-001. Preconditions: `unit_guuid` belongs to a **different** store than the mutation's `storeId`. Expected: `VALIDATION_FAILED` "unknown unit_guuid: …" (the `scope:'store'` resolver filters by `ctx.storeId`, so a genuinely-existing-elsewhere guuid reads as not-found) — must NOT resolve, must NOT leak whether the guuid exists in another store.

**PUSH-NEG-11 — Oversized numeric `money` via JSON-number bypasses the string-form digit cap**
Criticality: High · Same as PUSH-BOUND-12; listed here as its own negative case because the *expected-good* outcome (`VALIDATION_FAILED`) is not what happens — the actual outcome is an uncached `SERVER_ERROR` + poison-count increment. Treat this as a defect to confirm/fix, not just document.

**PUSH-NEG-12 — Same asymmetry for `quantity`**
Criticality: Medium · Input: `quantity: 123456789.1234` (JSON number, >9 integer digits and >3 decimals) on a `product_case` create. Expected (actual, verify): passes Zod, likely DB numeric overflow or silent truncation depending on Postgres numeric coercion — confirm actual DB behavior and whether it's a clean rejection or an uncached crash.

**PUSH-NEG-13 — Poison-cap message vs earlier crash-path message drift**
Criticality: Low · Compare the terminal poison-cap rejection message (`"mutation permanently failed after N attempts"`, BUSINESS_RULE, cached) against the pre-cap crash message (`"internal error applying mutation — safe to retry"`, no `conflict_type`, uncached). Confirm client can distinguish "give up" vs "keep retrying" purely from `status`+presence of `conflict_type` (see PUSH-UX-01).

---

### 3.5 Failure & recovery (Area: failure)

**PUSH-FAIL-01 — Retry after a dropped response (network cut after commit)**
Criticality: Critical · Traces to: BR-2, BR-SYNC-008. Steps: apply a create; simulate the client never receiving the HTTP response; resubmit the identical `mutation_id`+payload. Expected: second call returns `duplicate` with the cached `applied` result; **no second row created**; DB has exactly one customer.

**PUSH-FAIL-02 — Retry after `retry_later` (subscription transient) is NOT cached**
Criticality: Critical · Traces to: BR-8. Steps: mutation returns `retry_later` (e.g. paused subscription); un-pause the subscription; resubmit the same `mutation_id`. Expected: full handler re-execution (not a cache replay) → `applied`.

**PUSH-FAIL-03 — Retry after an uncached `SERVER_ERROR` re-runs the handler**
Criticality: High · Steps: force one transient handler exception (e.g. a momentary DB hiccup) below the poison threshold; resubmit same `mutation_id`. Expected: handler re-invoked (poison count now 1), succeeds on retry → `applied`. Confirm the FIRST attempt's rejection is **not** found in a subsequent idempotency lookup (uncached).

**PUSH-FAIL-04 — Poison cap reached mid-retry-loop**
Criticality: High · Traces to: PUSH-RULE-09. Steps: force 7 consecutive handler crashes for one `mutation_id`; 8th call. Expected: `rejected SERVER_ERROR` (cached, BUSINESS_RULE) and the handler is **not invoked** on the 8th call (verify via spy/log absence) — all further retries just replay this cached terminal result forever.

**PUSH-FAIL-05 — Idempotency race: two concurrent identical retries (double-fire bug)**
Criticality: Critical · Traces to: BR-2, BR-SYNC-008. Steps: fire two simultaneous `/sync/delta` calls with the exact same `mutation_id`+payload (simulating a client bug or a flaky-connection double-send). Expected: exactly one business effect commits; the other resolves via `RaceLostSignal` → polls the idempotency table (200ms interval, up to 3s) → returns `duplicate` with the winner's cached result. No double-apply, no crash.

**PUSH-FAIL-06 — Idempotency race exhausts the poll timeout**
Criticality: High · Steps: artificially slow the winner's commit (e.g. inject a delay) beyond `IDEMPOTENCY_RACE_POLL_TIMEOUT_MS` (3s) while the loser polls. Expected: loser throws `ServiceUnavailableError` (`503 SERVICE_UNAVAILABLE`) which **aborts the entire `/sync/delta` HTTP call** — confirm the client-facing contract: client retries the **whole batch**, and every already-applied mutation from earlier in this same call replays cleanly as `duplicate` on the retry (no double effects), even though their results were never delivered on the failed attempt.

**PUSH-FAIL-07 — Concurrent identical UPDATE (not just CREATE) resolves via the same race machinery**
Criticality: Critical · Steps: fire two identical `mutation_id` UPDATEs concurrently against the same row/version. Expected: first to acquire the row lock commits (`applied`, version+1); the second's own handler evaluation would otherwise look like a stale-version `conflict`, but its idempotency **claim** loses the race first → `RaceLostSignal` → entire second transaction (including its would-be conflict bookkeeping) rolls back → resolves to `duplicate` of the first's `applied` result, **not** a spurious `MASTER_DATA` conflict. This is a subtle but important correctness property — a naive implementation would surface a false conflict here.

**PUSH-FAIL-08 — Unmapped DB constraint violation (not 23505/23503)**
Criticality: Medium · Traces to: PUSH-NEG-11. Steps: trigger a Postgres error code `mapConstraintViolation` doesn't recognize (e.g. numeric overflow, check constraint). Expected: falls through to the generic crash handler → uncached `SERVER_ERROR`, poison-count bump, logged — confirm this doesn't silently swallow the error or corrupt the outer batch's other mutations.

**PUSH-FAIL-09 — Invalid/expired `sync_cursor` fails the WHOLE call before any mutation runs**
Criticality: Critical · Traces to: "must 400/410 up front, not after half the batch committed" comment. Input: a tampered-HMAC cursor, or a cross-tenant cursor (wrong `user`/`store` binding), or a >180-day-old (`ia`) cursor, submitted **alongside** 5 valid mutations in the same call. Expected: cursor decode throws before `runMutationWaves` is ever called → **zero** mutations applied → client sees a clean 400/410 and can safely retry the entire call with a corrected/omitted cursor.

**PUSH-FAIL-10 — Device session record missing/expired mid-flight**
Criticality: High · Traces to: `loadMutationEnv` fallback `sessionCreatedAt = session?.createdAt ?? now`. Steps: force `AuthSessionRepository.findById` to return null for the current `deviceSessionId` (e.g. session row purged/rotated) while pushing a mutation that needs grace (current permission already fails). Expected: `sessionCreatedAt` silently falls back to `now`, so the grace check's `clientAt < sessionCreatedAt` is true for essentially any real-world `client_modified_at` → grace is **always denied** regardless of whether the user was genuinely authorized when queued. Flag as a fail-closed side effect of a missing session row — confirm this is acceptable (fail-closed is safe) but note it can produce confusing false denials unrelated to the actual authorization history (see Q5).

**PUSH-FAIL-11 — Handler-level FK dangling reference after independent same-batch delete**
Criticality: High · Traces to: BR-4 waves. Steps: in one batch, without any `parent_guuid` link, submit a `product` **delete** and a `product_case` **create** referencing that same product's guuid — both unrelated per the wave algorithm (no shared guuid tracked via `parent_guuid`, so they can land in the **same** wave and run concurrently). Expected: verify actual outcome — since `resolveFks` does **not** filter out soft-deleted rows (see PUSH-EDGE-05), the case creation may succeed even though the product is (or is concurrently being) deleted in the same wave. Confirm result is at minimum non-corrupting (no orphaned FK at the DB level) even if business-logically surprising.

---

### 3.6 Concurrency (Area: concurrency) — CRITICAL priority territory

**PUSH-CONC-01 — Two devices push conflicting updates to the same customer, same stale version**
Criticality: Critical · Traces to: BR-1, BR-SYNC-009, BR-SYNC-010. Steps: Device A and Device B both queued an edit to the same customer offline, both hold `expected_row_version=3`. A pushes first (own `/sync/delta` call), then B pushes (separate, possibly overlapping call). Expected: A → `applied`, `row_version:4`. B → `conflict` (`MASTER_DATA`) with `server_row` reflecting A's committed values and `row_version:4`; B's edit is **never applied**; a `sync_conflicts` row exists for B's `mutation_id`.

**PUSH-CONC-02 — Two devices create the same client-generated guuid (guuid collision bug)**
Criticality: Critical · Traces to: BR-10. Steps: Device A and B both offline-generate a customer with the identical `guuid` (simulating a broken UUID generator or a copy-paste bug in test data) under **different** `mutation_id`s. Expected: whichever commits first → `applied`. The second → savepoint-level Postgres `23505` → mapped to `rejected DUPLICATE_ENTRY` ("This was already saved from another device.") — **not** silently merged, not a `conflict`, no data loss (the second customer is simply never created; the offline cashier must be told to reconcile manually).

**PUSH-CONC-03 — Same `mutation_id` fired twice in true parallel (double-tap / flaky-retry storm)**
Criticality: Critical · Same as PUSH-FAIL-05, re-listed under concurrency: assert exactly one commit, the loser resolves via poll, not via a second independent write.

**PUSH-CONC-04 — Same-entity create+update in one batch, no explicit `parent_guuid`**
Criticality: High · Traces to: BR-4 `computeWaves` (`lastWaveForGuuid`). Input: `[{action:'create', payload:{guuid:G,...}}, {action:'update', payload:{guuid:G,...}, expected_row_version:1}]` for the same product guuid, no `parent_guuid` set on the second. Expected: the algorithm still forces the update into a **later wave** than the create (tracked purely via `payload.guuid`, independent of `parent_guuid`) — the update sees `row_version:1` from the just-committed create, not a stale/nonexistent row. If this ordering guarantee were broken, the update would race the create and likely fail as `NOT_FOUND`.

**PUSH-CONC-05 — Child listed before parent in the request array**
Criticality: High · Traces to: BR-4 `topoSort`. Input: `mutations = [child(parent_guuid=P), parent(guuid=P)]` (child physically first in the array). Expected: `topoSort` reorders so parent still runs in an earlier wave than the child, regardless of client-submitted order — verify both apply successfully.

**PUSH-CONC-06 — Circular `parent_guuid` reference in one batch**
Criticality: Medium · Input: mutation A's `parent_guuid` = B's guuid, and B's `parent_guuid` = A's guuid, both in the same batch. Expected: `topoSort`'s cycle guard (visited-stack check) falls back to original request order for the cycle — both mutations still process (no infinite loop, no silent drop); document the actual resulting wave assignment as the source of truth (no PARENT_FAILED cascade for either, since neither's parent is in `failedGuuids` before either runs).

**PUSH-CONC-07 — Cached-rejected parent from a PRIOR call, parent not resubmitted in this batch**
Criticality: Critical · Traces to: BR-5, PRD S-3 (documented remaining gap). Steps: call 1 — parent mutation rejected (e.g. duplicate guuid), cached. Call 2 — client sends **only** the child (`parent_guuid` = the rejected parent's guuid), does **not** resend the parent mutation at all. Expected (verify current behavior — likely a real gap): `env.failedGuuids` is built **only from mutations processed in the current request**; since the parent isn't in this batch, `failedGuuids` never contains its guuid, so the child's cascade check misses and the child's handler runs against a parent that was never created — likely surfacing as `VALIDATION_FAILED "unknown X_guuid"` or `FOREIGN_KEY_VIOLATION`, **not** the clean `PARENT_FAILED` a client would expect to route correctly. Flag this as the one S-3 sub-gap the code's "S-3b fix" comment does **not** cover (it only covers "parent replays as duplicate **within this same batch**").

**PUSH-CONC-08 — Two admins resolve the same conflict concurrently**
Criticality: Medium · Traces to: `SyncConflictRepository.resolve` (no optimistic lock on this bookkeeping row). Steps: two `PATCH /sync/conflicts/:mutationId` calls, different `status`/`note`, fired concurrently. Expected: last-write-wins at the DB level; **both requests return 200** with no error to either caller, and the final stored state reflects whichever committed last — the "losing" admin gets no signal their resolution was overwritten. Flag as a minor real gap (see Q6).

**PUSH-CONC-09 — Batch of >`WAVE_CONCURRENCY` (4) fully-independent mutations**
Criticality: Low (load-correctness, not a functional bug) · Input: 20 independent creates across 5 entity types, no shared guuids. Expected: all `applied`; internally bounded to ≤4 concurrent transactions at a time (verify via connection-pool metrics or timing) — confirms one device's large batch cannot starve the shared DB pool (`WAVE_CONCURRENCY=4` vs pool size 10).

**PUSH-CONC-10 — Multi-store device: concurrent pushes to two different stores by the same user**
Criticality: High · Traces to: BR-SYNC-001. Steps: user has access to Store A and Store B; fire concurrent `/sync/delta` calls to `stores/A/sync/delta` and `stores/B/sync/delta`. Expected: fully isolated — idempotency keys, rate-limit buckets, and RBAC/subscription context are all keyed per `(user, store[, device])`; no mutation from A's batch is visible in B's results, no rate-limit bleed between the two calls.

---

### 3.7 Permissions / roles (Area: permission)

**PUSH-PERM-01 — Cashier without edit permission, no grace history**
Criticality: Critical · Input: cashier role lacking `Product:edit` attempts a product update, no `client_modified_at`. Expected: `rejected PERMISSION_DENIED`.

**PUSH-PERM-02 — Grace honored exactly at the boundary**
Criticality: Critical · Same as PUSH-RULE-04/PUSH-BOUND-09 — re-verify from the permission-role angle: a role revoked 29 minutes ago, mutation queued 20 minutes ago (before revocation) → `applied` via grace.

**PUSH-PERM-03 — Conflict resolution gated on `view`, not `edit`, not ownership**
Criticality: High · Traces to: A3/Q2. Input: a role with `Product:view` but **not** `Product:edit` calls `PATCH /sync/conflicts/:mutationId` for a product conflict submitted by a **different** user. Expected (per current code): **succeeds** — `SyncConflictService.canView` only checks `view`, and `SyncConflictRepository.resolve` filters only by `(storeId, mutationId)`, never `userFk`. Confirm this is the intended permission model (see Q2) — as written, a low-privilege "view-only" role can flip another user's conflict to `resolved`/`discarded`.

**PUSH-PERM-04 — Cross-store storeId manipulation**
Criticality: Critical · Traces to: TenantGuard. Input: user has access to Store A only; sends `POST /stores/B/sync/delta`. Expected: `404 STORE_NOT_ACCESSIBLE` at `TenantGuard`, before `DeviceSlotGuard`/push logic ever runs — confirm identical 404 whether Store B doesn't exist or simply isn't accessible (timing-oracle safety).

**PUSH-PERM-05 — `@AllowExpiredSubscription` bypasses the route guard, not the per-mutation gate**
Criticality: Critical · Traces to: BR-8, controller's `@AllowExpiredSubscription()` on `pushDelta`. Input: account `status='expired'`, `accessValidUntil` in the past; call `/sync/delta` with one write mutation whose `client_modified_at` is **after** the lapse. Expected: the **route-level** `SubscriptionStatusGuard` does **not** 402 the whole call (bypassed by the decorator); instead the **pull portion** of the response returns normally, and the **mutation** itself is rejected per-item with `SUBSCRIPTION_LAPSED_AT_WRITE`. Contrast with a mutation stamped **before** the lapse in the same call → that one applies. Confirms the two mechanisms (route guard vs per-mutation gate) don't double-block or under-block each other.

**PUSH-PERM-06 — Permission revoked between two mutations in the SAME batch**
Criticality: Medium · Input: a batch where mutation #1 (product edit) is evaluated while the role still has permission, but permission is revoked (by an out-of-band admin action) **during** processing of the batch, before mutation #7 (also a product edit) is evaluated. Expected: since `env.permissions` is loaded **once** per request (`loadMutationEnv`) and reused for every mutation in the batch, **all** mutations in this single call are evaluated against the **same** permission snapshot — #7 still succeeds even though the revoke technically happened moments earlier mid-batch. Document this as expected (per-request permission snapshot, PRD §18) rather than a bug — the NEXT `/sync/delta` call will see the revoked permission.

**PUSH-PERM-07 — `permissions_version` forced-fresh read**
Criticality: Low · Traces to: `rbac.getCachedPermissions(userId, storeId, true)` (third arg forces bypass of any stale cache). Expected: verify a permission change made moments before this exact push call is reflected (not served from a stale cache) — i.e., push always evaluates against genuinely current permissions, unlike some other read paths that may tolerate cache staleness.

---

### 3.8 State transitions (Area: state)

**PUSH-STATE-01 — Update a guuid that never existed**
Criticality: High · Expected: `rejected NOT_FOUND`, message "`<entity>` `<guuid>` does not exist in this store".

**PUSH-STATE-02 — Update a soft-deleted entity's guuid**
Criticality: High · Expected: `rejected NOT_FOUND`, message "`<entity>` `<guuid>` was deleted on the server" — **distinct message** from STATE-01; confirm client can't tell the two apart from `code` alone (both `NOT_FOUND`) only from `message` text, which is fragile for client-side branching (see Q7).

**PUSH-STATE-03 — Delete an already-deleted entity (idempotent re-delete)**
Criticality: High · Traces to: tombstone re-surfacing. Expected: `applied` (NOT an error) — `entityGuuid` returned, tombstone's `deleted_at` refreshed so it re-surfaces via the keyset for any device that missed the first delete.

**PUSH-STATE-04 — Delete a guuid that never existed**
Criticality: Medium · Expected: `rejected NOT_FOUND`, "does not exist in this store".

**PUSH-STATE-05 — Create reusing a guuid from a soft-deleted row**
Criticality: Critical · Traces to: BR-10. Steps: delete a customer (soft), then attempt to `create` a **new** customer reusing that same `guuid`. Expected: DB unique constraint on `guuid` still fires (soft-delete does not free it) → `rejected DUPLICATE_ENTRY` — confirm guuids are permanently reserved once used, even post-delete; a client that recycles guuids after "undo delete" flows must mint a fresh one.

**PUSH-STATE-06 — Create/update/delete a global (store_fk NULL) lookup value**
Criticality: High · Traces to: BR-11. Input: attempt to `update` or `delete` a seeded global lookup row via push. Expected: `rejected NOT_FOUND` "does not exist in this store" — even though the row genuinely exists (just not store-scoped) — the storeFk-scoped `WHERE` makes it unreachable; message is honestly slightly misleading ("doesn't exist" vs "isn't yours to edit") — flag as a minor UX nuance, not a security bug (correct outcome, imprecise wording).

**PUSH-STATE-07 — `isSystem` lookup: create is unaffected, update/delete are blocked**
Criticality: Medium · Same as PUSH-RULE-11 — re-verify: no push payload can set `is_system=true` on create (field absent from `createSchema`), so this class of row can only be seeded server-side/by migration, never manufactured via push to accidentally lock out future edits to a client-created row.

---

### 3.9 Cross-cutting: offline/sync, time, tenancy (Area: offline-sync)

**PUSH-CROSS-01 — Clock-fast device: base skew clamp never rejects**
Criticality: Critical · Traces to: BR-7, BR-SYNC-020. Input: device clock 10 minutes fast; user still holds current permission; `client_modified_at = now_server + 10min`. Expected: `effectiveAsOf` clamps to `env.now` (server-now) since `clientAt` is **not** `< env.now` — the mutation is evaluated and applied at server-now; **never rejected for being "in the future"** at this layer (only the grace-path future-check, a different code path, is strict — see CROSS-02).

**PUSH-CROSS-02 — Clock-fast device WITH a failed current-permission check hits the strict grace future-check**
Criticality: Critical · Traces to: BR-7 contrast case. Input: same 10-minutes-fast clock, but this time the user's **current** permission check also fails (so the grace path is invoked). Expected: **denied** — "not authorized (client_modified_at is in the future)" — because the grace path's ±5min check is strict about backdating/forward-dating privilege, unlike the always-lenient base skew clamp. Document both CROSS-01 and CROSS-02 side by side — they look contradictory unless you know which code path each mutation entered.

**PUSH-CROSS-03 — Offline for 45 minutes, revoked at minute 40, pushed at minute 45+**
Criticality: Critical · Traces to: A2/Q1, the 30-min grace cap. Confirms PUSH-RULE-04b's exact numeric scenario end-to-end with a realistic offline-duration narrative (a cashier's shift ends, phone stays in a locker offline for 45 minutes while an admin revokes their role at minute 40, then the phone reconnects and pushes a sale-adjacent edit queued at minute 10). Expected: `rejected PERMISSION_DENIED` — grace does not reach back far enough, even though the edit itself was genuinely authorized when made.

**PUSH-CROSS-04 — Self-echo: pushing an edit and pulling in the same call**
Criticality: Medium · Input: a create mutation + an existing (older) `sync_cursor` in one `/sync/delta` call. Expected: the pull portion (computed strictly **after** all mutations commit) may include the just-created row in `changes` if the cursor is old enough to still be behind it — confirm this is harmless (client-side idempotent upsert-by-guuid) rather than a duplicate-creation risk.

**PUSH-CROSS-05 — `supported_entity_types` filters pull only, never push**
Criticality: Medium · Input: `supported_entity_types:['customer']` alongside a `product` mutation in the same batch. Expected: the product mutation still processes normally (push is entity-type-filter-blind); only the `changes` portion of the response is restricted to `customer`.

**PUSH-CROSS-06 — Multi-store partitioning end-to-end**
Criticality: High · Same as PUSH-CONC-10, from a data-integrity angle: confirm a mutation pushed against Store A's `:storeId` can **never** resolve an FK guuid or match an idempotency/poison-count row belonging to Store B, even if the same user and even the same literal `mutation_id` string is reused across both stores (compound key includes `storeFk`).

**PUSH-CROSS-07 — Reconnect ordering: push-before-pull is structural, not just advisory**
Criticality: Medium · Traces to: PRD §20 "push queue first, then pull". Confirm the combined endpoint's internal ordering (`runMutationWaves` fully awaited before `buildResult`'s pull) makes this a **structural guarantee** server-side (not merely a client-side convention) — a device that queued a local edit will never have its OWN push-in-this-call raced by the SAME call's pull.

---

### 3.10 UX / response-shape correctness (Area: UX)

**PUSH-UX-01 — `conflict_type` presence is inconsistent across SERVER_ERROR outcomes**
Criticality: Medium · Traces to: BR-12. Compare: the poison-cap terminal rejection (`SERVER_ERROR`, `conflict_type:'BUSINESS_RULE'`, cached) vs. the pre-cap generic crash rejection (`SERVER_ERROR`, **no `conflict_type` key at all**, uncached). Expected: a client that switches UX purely on `conflict_type` must also special-case "field absent" for this one `code`, or it will mis-route this specific rejection. Recommend: always populate `conflict_type` (even if `'BUSINESS_RULE'` or a new transient category) — flag for dev follow-up (Q8).

**PUSH-UX-02 — Cached-conflict duplicates strip `server_row` consistently across all three replay call sites**
Criticality: Medium · Traces to: privacy/staleness of a long-cached conflict snapshot. Verify all three places that replay a cached result (`processOne`'s live-idempotency check, the DUPLICATE_ENTRY-race special case in `mapExecuteFailure`, and `pollRaceWinner`) apply the identical `{...cached, server_row: undefined}` sanitization when `status==='conflict'` — confirm no code path leaks a stale `server_row` snapshot to a client that replays the mutation long after the fact (conflicts TTL at 5 min specifically to bound this window — verify a >5-min-old conflict mutation_id genuinely re-executes fresh, rather than replaying stale data).

---

## 4. Edge-case scenarios (§5 checklist — the ones teams miss)

**PUSH-EDGE-01 — Empty batch**
Criticality: Low · Input: `mutations: []` (or omitted — schema defaults to `[]`). Expected: `mutation_results: []`; the pull portion still runs normally if `sync_cursor` present — confirms a pure-pull call can be made through this endpoint without error.

**PUSH-EDGE-02 — Null/blank optional fields**
Criticality: Medium · Input: `phone: null`, `email: null` on a customer create (fields are `.nullish()`). Expected: stored as SQL NULL, not rejected, not coerced to empty string.

**PUSH-EDGE-03 — Whitespace-only required string**
Criticality: Medium · Input: `name: "   "` (customer/product/supplier `name`). Expected (verify): Zod's `min(1)` counts whitespace as length ≥ 1, so this is **accepted** and stored as a whitespace-only name — flag as a data-quality gap; no server-side `.trim()` before the length check.

**PUSH-EDGE-04 — First-ever mutation for a brand-new store**
Criticality: Medium · Preconditions: store just created, zero customers/products. Input: first customer create. Expected: `applied`, `row_version:1` — no off-by-one or "first row" special case.

**PUSH-EDGE-05 — FK resolvers don't check aliveness (dangling reference to a soft-deleted parent)**
Criticality: High · Traces to: `resolveFks` in `master-data.handler.ts` (no `aliveWhere()` filter applied to the FK lookup, unlike the direct-guuid lookups used for update/delete). Input: soft-delete a `unit`... wait — `unit` has no push handler, so use a deletable FK target instead: soft-delete a `product`, then push a **new** `product_case` whose `product_guuid` points at that now-deleted product. Expected (verify current behavior): the FK resolver's `SELECT` has no `deletedAt IS NULL` clause, so it **still resolves successfully** — a client can create a case (or set a customer's `customer_type_lookup_guuid`, or a product's `category_lookup_guuid`, to a deleted lookup) referencing a dead parent with **no error at all**. Flag as a genuine, currently-unenforced business rule gap (see Q9) — decide whether FK resolution should require the target to be alive.

**PUSH-EDGE-06 — Duplicate `mutation_id` submitted twice within the SAME batch**
Criticality: Medium · Traces to: `runMutationWaves`'s `seenIds` de-dupe. Input: two entries in `mutations[]` sharing one `mutation_id` (different or identical payloads). Expected: only the **first occurrence** is actually processed; the response's `mutation_results` maps **both** array positions to the **same** result object (via `results.get(m.mutation_id)`) — confirm the client sees one coherent outcome for both, not an error, and not two different results for one id.

**PUSH-EDGE-07 — Out-of-order delivery: a later-queued mutation's push arrives/is-processed before an earlier one**
Criticality: Medium · Traces to: the wave/topoSort mechanism only orders by `parent_guuid`/same-guuid — it has **no** concept of "client queue order" beyond that. Input: two **unrelated** mutations (different guuids, no parent link) where the client's local queue processed them in a specific order, but network conditions deliver a *later* `/sync/delta` call before an *earlier* one (e.g., two separate HTTP calls racing). Expected: server has no way to detect or enforce true wall-clock queue order across **separate** calls — only same-call, same-guuid/parent ordering is guaranteed. Confirm this is a known, accepted limitation (client-side sequencing is the client's job for cross-call ordering) rather than an assumed guarantee — call out explicitly so no one assumes cross-call FIFO.

**PUSH-EDGE-08 — Cascade dependent on parent being resubmitted in the same batch (restated from PUSH-CONC-07)**
Criticality: Critical · The single clearest "commonly missed" case: teams often assume `parent_guuid` cascade works across a device's entire retry history; it only works **within one HTTP call**. Explicitly test the negative: parent rejected on Monday, child pushed alone on Tuesday referencing Monday's parent guuid → no `PARENT_FAILED`, handler runs, likely a confusing downstream FK/validation error instead.

**PUSH-EDGE-09 — Permission revoked mid-flow, mutation queued just before revoke, device stays offline past the 30-min grace window before finally pushing**
Criticality: Critical · Restates PUSH-CROSS-03 as the canonical "permission-change-mid-flow" checklist item — the single most consequential grace-related edge case for a retail app where phones sit in lockers or lose signal in a back room.

**PUSH-EDGE-10 — Abandonment: app killed mid-batch-construction, later relaunch resubmits a superset batch**
Criticality: Medium · Input: client app crashes after queuing mutations #1–#5 locally but before sending; on relaunch it rebuilds and sends #1–#8 (including the original 5 plus 3 new ones) in one call, OR splits across two calls with #1-3 in call 1 and #1-8 in call 2 (naive queue replay). Expected: mutations #1–#5, if genuinely identical `mutation_id`s to a *previous already-committed* call, replay as `duplicate`; if this is truly their *first* delivery (app never actually sent them before crashing), they process normally. Confirm the boundary: idempotency is purely `mutation_id`-keyed, so a crash **before** any network send is safe (nothing to dedupe against yet) and a crash **after** commit-but-before-ack is exactly PUSH-FAIL-01 — there is no third, ambiguous state that produces a double-apply.

---

## 5. Coverage summary matrix

| Requirement / Business rule | Satisfied case(s) | Violated case(s) | Gap? |
|---|---|---|---|
| BR-1 optimistic lock required on update | PUSH-RULE-01a | PUSH-RULE-01b | — |
| BR-1 stale version → conflict, not overwrite | PUSH-RULE-02a | PUSH-RULE-02b, PUSH-CONC-01 | — |
| BR-2 idempotency same-tx / duplicate replay | PUSH-FAIL-01 | PUSH-FAIL-05/06/07 (race edges) | — |
| BR-3 per-mutation tx isolation | PUSH-HAPPY-06 | PUSH-NEG-04 (one bad mutation, siblings unaffected) | — |
| BR-4 dependency-sorted waves | PUSH-HAPPY-07, PUSH-CONC-04/05/06 | PUSH-CONC-06 (cycle) | — |
| BR-5 cascade-fail (`PARENT_FAILED`) | PUSH-RULE-10a | PUSH-RULE-10b | PUSH-CONC-07/PUSH-EDGE-08: cascade doesn't reach across separate calls — **documented gap, not covered by a passing case** |
| BR-6 point-in-time grace (§12, 3-layer) | PUSH-RULE-04a, 05a, 06a | PUSH-RULE-04b, 05b, 06b | grace-window cap (BR-6c) behavior needs product confirmation — Q1 |
| BR-7 skew clamp vs grace future-check | PUSH-CROSS-01 | PUSH-CROSS-02 (contrast, not a "violation" but a documented divergence) | — |
| BR-8 subscription write-gate | PUSH-RULE-07a, 08a | PUSH-RULE-07b, 08b | — |
| BR-9 poison cap | PUSH-RULE-09a | PUSH-RULE-09b, PUSH-FAIL-04 | — |
| BR-10 guuid permanence | PUSH-STATE-05 | (same case — DB constraint is the enforcement) | — |
| BR-11 lookup protections | PUSH-RULE-11a, PUSH-STATE-07 | PUSH-RULE-11b, PUSH-STATE-06 | STATE-06 message wording imprecise — Q7 |
| BR-12 conflict_type tagging | most `rejected`/`conflict` cases | — | PUSH-UX-01: one path omits `conflict_type` entirely |
| BR-SYNC-001 tenant partitioning | PUSH-CROSS-06, PUSH-CONC-10 | PUSH-NEG-10 (cross-store FK) | — |
| BR-SYNC-007 per-mutation tx, 5xx aborts call | PUSH-HAPPY-06 | PUSH-FAIL-06, PUSH-FAIL-09 | — |
| Payload size cap (S-36) | PUSH-RULE-12a | PUSH-RULE-12b, PUSH-BOUND-03 | — |
| `money`/`quantity` validation | PUSH-BOUND-04/05 | PUSH-BOUND-12, PUSH-NEG-11/12 | **Real gap** — numeric-input branch bypasses digit/decimal cap; see Q3 |
| Device slot entitlement | PUSH-RULE-13a | PUSH-RULE-13b | — |
| Subscription route-guard bypass (`@AllowExpiredSubscription`) | PUSH-PERM-05 | — | — |
| Conflict resolution permission model | PUSH-PERM-03 | — | Needs product confirmation — Q2 |
| State: not-found vs deleted vs stale-version | PUSH-STATE-01/02/03 | — | Same `code` for two different meanings (STATE-01 vs 02) — Q7 |
| FK-resolver aliveness | — | PUSH-EDGE-05 | **Real gap** — no aliveness check on FK targets; Q9 |

---

## 6. Priority roll-up — run these first

**Critical (money/data-integrity/concurrency/auth — must pass before anything else):**
PUSH-RULE-02b (conflict, not overwrite), PUSH-CONC-01/02/03/07, PUSH-FAIL-01/05/06/07, PUSH-RULE-04a/b
(grace honored / grace-window cap), PUSH-RULE-07a/b (subscription point-in-time), PUSH-PERM-04/05,
PUSH-NEG-02 (unbuilt entities cleanly reject, never half-apply), PUSH-NEG-10 (cross-tenant FK isolation),
PUSH-STATE-05 (guuid permanence), PUSH-FAIL-09 (bad cursor aborts before any mutation), PUSH-EDGE-08
(cascade-across-calls gap — must be a *known* gap, not a silent one).

**High:** all remaining §3.2 rule pairs, PUSH-BOUND-10/12, PUSH-CONC-04/05/09/10, PUSH-PERM-01/02/06,
PUSH-STATE-01/02/06, PUSH-CROSS-01/02/03, PUSH-EDGE-05.

**Medium/Low:** boundary string-length/decimal cases, UX consistency (PUSH-UX-01/02), conflict-resolution
race (PUSH-CONC-08), whitespace-name (PUSH-EDGE-03), load/perf (PUSH-CONC-09).

---

## 7. Open questions (need product/dev confirmation)

- **Q1 (A2):** Is it intentional that grace authorization caps at `now − 30min` regardless of how much
  earlier the mutation was genuinely authorized (PUSH-RULE-04b / PUSH-CROSS-03)? If a cashier's phone is
  offline for hours with a legitimately-queued edit and their role gets revoked at any point in that
  window, the edit can be denied even though it predates the revocation. Confirm this is the accepted
  trade-off (bounding worst-case exposure) vs. a bug that should instead compare against the mutation's
  **true** `effectiveAsOf` with no upward clamp.
- **Q2 (A3):** Should `PATCH /sync/conflicts/:mutationId` require `edit` permission (or original-submitter
  match) rather than just `view`? As written, a view-only role can resolve/discard another user's
  conflict (PUSH-PERM-03).
- **Q3:** Is the `money`/`quantity` numeric-JSON-input branch's missing digit/decimal-place cap
  (PUSH-BOUND-12, PUSH-NEG-11/12) a known/accepted asymmetry, or a bug to fix in
  `payload-helpers.ts`? As-is, an oversized numeric value surfaces as an uncached `SERVER_ERROR`
  (counting toward the poison cap) instead of a clean `VALIDATION_FAILED`.
- **Q4:** Should silently-ignored immutable-field updates (e.g. sending `code` on a lookup update,
  PUSH-NEG-09) surface a warning/rejection instead of a silent no-op, to help clients catch their own
  bugs?
- **Q5:** When the device-session lookup misses (`sessionCreatedAt` falls back to `now`, PUSH-FAIL-10),
  is fail-closed (deny grace) the desired behavior, or should a missing session be treated differently
  (e.g., reject the whole call rather than silently degrading every grace check in the batch)?
- **Q6:** Is concurrent conflict-resolution last-write-wins (PUSH-CONC-08) acceptable, or does this
  bookkeeping table need its own optimistic lock / resolved-status guard?
- **Q7:** Should "row doesn't exist" vs "row was deleted" (PUSH-STATE-01/02) carry distinct error codes
  instead of sharing `NOT_FOUND` with only the message text differing? Same question for the
  "global lookup, unreachable" `NOT_FOUND` (PUSH-STATE-06) which is really a scope/permission distinction
  wearing a not-found message.
- **Q8:** Should every non-`applied` result always populate `conflict_type` (PUSH-UX-01), including the
  generic uncached crash path, so client-side UX routing never has to special-case an absent field?
- **Q9:** Should FK resolvers (`resolveFks` in `master-data.handler.ts`) require the referenced row to be
  **alive** (not soft-deleted / `is_active`), closing PUSH-EDGE-05? Currently a client can wire a new
  record to a dead parent with no error.
- **Q10:** Confirm the exact comparison operators at the two 5-minute/30-minute boundaries (PUSH-BOUND-08/09)
  so an automated test can assert the precise inclusive/exclusive edge rather than inferring it from
  reading `>`/`<` in the source.