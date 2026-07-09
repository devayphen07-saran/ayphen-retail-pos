# Image / File Upload — Four-Lens Review

> The flow trace in `image-upload-flow.md` was run through four independent reusable agent
> methodologies from this repo's `docs/agent/`, each attached and pointed at the flow doc plus the real
> source in `/Users/saran/Downloads/ayphen-3.0` and `/Users/saran/ayphen-mobile/ayphen-frontend`:
>
> 1. **[CLAUDE-critic.md](CLAUDE-critic.md)** — Flow & Design Critic: is the architecture correct, what
>    are the alternatives, which wins.
> 2. **[CLAUDE-decision.md](CLAUDE-decision.md)** — Decision-Making Agent: same question, framed as a
>    decision with production-issue handling and a right-size check.
> 3. **[CLAUDE-backend-standard.md](../backend/agent/CLAUDE-backend-standard.md)** — Enterprise Backend
>    Engineering Standard, applied as a review checklist to the `ayphen-3.0` backend implementation.
> 4. **[CLAUDE-backend-architect.md](../backend/agent/CLAUDE-backend-architect.md)** — Senior Backend
>    Architect: an architecture-level specification and decision for the backend's storage design.
>
> All four independently re-verified claims against source rather than trusting the flow doc summary;
> where they found corrections, those are recorded in `image-upload-flow.md`'s **Errata** section and
> referenced inline below rather than repeated in full.

---

## Cross-lens summary (read this first)

All four reviews converge on the same three defects as the highest-priority fixes, reached
independently through four different methodologies:

1. **The endpoint every client actually calls performs zero validation and has no tenant attribution**
   (`POST /api/v1/files/temp/upload` → `uploadToTemporaryStorage`, `FilesServiceImpl.java:832-867`).
   This is a sharper, previously-unstated finding — the original flow doc traced a *different*,
   currently frontend-unreachable endpoint (`processFileUpload`) as if it were the one in use.
2. **`temporary_files` has no tenant column**, and the reach of that gap is wider than the flow doc's
   delete-only framing: it also affects the promotion/link path and the generic delete branch used by
   ~90 call sites across nearly every domain service in the backend.
3. **The storage-quota check is a live, unlocked `SUM` read** — a textbook TOCTOU race on a hard
   entitlement, made worse by also being an O(all-files-for-this-company) query with no supporting
   index.

Two new findings surfaced only by these reviews' independent re-verification, not visible from the
flow trace alone:

- **The global exception handler is broken by a same-package class-name collision** and never catches
  the real JDK exceptions this feature actually throws (see Errata #4).
- **A third, previously uncounted delete mechanism** exists with the same severity as the worst of the
  two already documented (Errata #3).

`FilesHelper` (the second, DB-blob pipeline) is unanimously recommended for **deletion**, not repair —
all four reviews independently confirmed it has zero HTTP-reachable callers today.

---

## 1. Flow & Design Critic — is the architecture correct?

*(Full methodology: `CLAUDE-critic.md`. Scope: the temp-upload-then-link + presigned-read pattern every
surface converges on, plus the delete mechanisms and the `FilesHelper` second pipeline.)*

### Restatement

The architecture is: pick/capture on the client → multipart POST to a generic, unauthenticated-by-annotation
"temp" endpoint → S3 write + a `TemporaryFile` row with no tenant column → accumulate any number of these
while the user fills out a form (client-side "remove" is local-array-only, never hits the backend) → on
save, the client sends the collected `fileKey`s and a domain-specific path validates them for the first
time and promotes them into the tenant-scoped `Files` table → retrieval is always a fresh presigned GET
URL. Two variants coexist rather than one clean model: ticket attachments use a one-step
upload-and-link-in-one-call pattern instead (and even that's undermined elsewhere — the ticket
create/edit form uses the two-step pattern but has its link call commented out, silently orphaning
files); and two independent backend storage pipelines exist for the same `Files` table (the S3 path and
the dead `FilesHelper` DB-blob path).

### Correctness verdict — **Flawed**

Not because the two-phase stage-then-link *shape* is wrong (it's a legitimate, common pattern) — it's
flawed because of what the implementation does at the trust boundary, and because the shape is applied
inconsistently. Stress-traced:

- **Trust boundary (critical):** the one endpoint every surface calls has zero validation — no
  extension check, no size check beyond Spring's blanket 20MB multipart cap, no quota check, no company
  binding. Any client that never completes the link step (abandoned form, the ticket-form bug, a
  deliberately hostile script) gets a fully-uploaded, permanently-unvalidated file that nothing ever
  revisits.
- **Tenancy (critical, confirmed live):** `temporary_files` has no tenant column by schema design.
  Delete *and* the promotion/link path both look up by `fileKey` alone. Any authenticated user of any
  tenant who obtains another tenant's `fileKey` (returned in plaintext on every upload response) can
  delete their staged file, or — more subtly — "link" a foreign tenant's still-temp file into their own
  record, since nothing checks ownership at promotion either.
- **Cascading unauthorized destruction (critical, newly confirmed):** two of three delete endpoints
  have no `@PreAuthorize` and no tenant parameter at all; one of them (`/delete/{id}`) reaches
  **permanent, already-committed files**, not just staged ones, and does a real, unrecoverable S3
  delete.
- **Partial failure:** S3-write-before-DB-insert on create (orphan on insert failure, no reconciliation
  job exists); delete-old-before-upload-new on update (an *active* row can point at a deleted key);
  copy-then-delete on trash-move (no rollback).
- **Retry/idempotency:** no idempotency key anywhere; the confirmed mobile FormData double-append bug
  plus the missing double-tap guard means a double-tap produces two concurrent uploads with no dedupe.
- **Concurrency:** the quota check is read-then-compare with no lock — two concurrent uploads can both
  pass and jointly overshoot the allocation.
- **Offline/cellular:** no client-side timeout anywhere in the mobile path; a stalled POST hangs
  indefinitely with nothing shown to the user, no retry, no offline queue — for an app whose core mobile
  use case is store-floor/field cellular connectivity, this is a first-order defect, not a corner case.
- **Scale:** bytes are proxied client → backend → S3 for every upload; the backend is the availability
  bottleneck and holds the connection open for the full upload duration — the first thing to saturate at
  100x traffic.
- **Cascade/orphan accumulation:** because "delete" is local-only everywhere except ticket attachments,
  and there's no expiry/sweep on the temp endpoint, every abandoned form and every picked-then-removed
  file permanently accumulates unvalidated rows and S3 objects with zero garbage collection.

**Where it holds:** the read side (always-fresh presigned GET, never a stored long-lived URL) is correct
and appropriately defends against link rot/URL leakage. Permanent-table lookups for retrieve/restore/edit
are correctly tenant-scoped. Ticket-attachment delete is the one fully-correct end-to-end flow in the
entire survey.

### Alternatives considered

- **(a) Given approach** — generic temp-upload-then-link (staging-table pattern).
- **(b) Direct-to-S3 presigned PUT** — backend issues a scoped presigned PUT; client uploads straight to
  S3; a lightweight "confirm" call records metadata. Removes the backend from the byte-transfer hot path.
- **(c) One-step upload-and-link (entity-attached upload)** — the pattern ticket attachments already
  use: upload directly against the parent entity in one call, no floating temp state. Simplest-possible
  anchor for this app, since it needs the least new machinery.
- **(d) Chunked/resumable upload** (tus-style, or client-driven S3 multipart) for large files on flaky
  mobile networks.
- **(e) Async outbox + worker** (heaviest anchor) — pending state, background virus-scan/transcode
  worker, retry + dead-letter path before a file is "committed."
- **(f) Do nothing** — explicit zero-effort anchor, rejected outright given the live tenancy gap.

### Head-to-head comparison

**Weighting for this app**: security & tenancy dominates every other dimension — it's a gate, not a
tradeoff axis, given the confirmed live cross-tenant destruction hole. Second: mobile/cellular
resilience (two of three clients are mobile apps on real cellular networks with zero timeout/retry
today) and failure/orphan recovery (already observed accumulating, not hypothetical). Third: simplicity
& ops (this codebase already shows signs of a stretched team — copy-pasted validation logic, a
commented-out link call shipped to production, a dead parallel pipeline nobody removed — new machinery
must be justified hard). Raw performance/scale and strong consistency are weighted low — this is
dockets/receipts/tickets/logos volume, not a high-throughput event system.

| Approach | Security & tenancy | Mobile/cellular fit | Failure & orphan recovery | Simplicity & ops | Scale/backend cost | Verdict |
|---|---|---|---|---|---|---|
| (a) Given: temp-then-link | Fails today — schema gap + unscoped deletes | Proxies every byte, no timeout/retry, no chunking | No expiry/sweep; validation skippable by never saving | One pattern in theory, inconsistently applied and duplicated mobile/web | Backend holds every connection open, doubles bandwidth | Reject as-implemented; the two-phase shape is salvageable, the tenant-less table and unscoped deletes are not |
| (b) Direct-to-S3 PUT | Fixable cleanly with tenant-prefixed keys | Best backend-cost profile, but still one shot-in-the-dark PUT with no chunking | New "confirm" design needed — new orphan class if confirm never arrives | New moving part in both RN apps and web — real, non-trivial lift | Removes backend from hot path — best scale story | Strong long-term fit, too large a single change to do first |
| (c) One-step upload-and-link | Naturally fixed — already entity/tenant-scoped by construction | Same backend-proxy cost as (a) | Eliminates the orphan class structurally — no "unlinked" state to abandon | Fewer moving parts than (a): no temp table, no promotion logic | Same as (a) | Fixes the tenant/orphan defects with the least new infrastructure — already proven to work in this codebase |
| (d) Chunked/resumable | Orthogonal | Best-in-class for real cellular loss | Needs its own state machine | Significant new protocol/infra on both clients | Neutral to slightly worse | Overkill for today's file sizes — correct to reject now, revisit if attachment types change |
| (e) Async outbox+worker | Orthogonal | No client-side improvement | Real safety net for inbound email attachments specifically | Heaviest option: queue, worker, retry/DLQ, monitoring | Adds latency before "committed" | Right tool for the mail-attachment vector specifically, wrong scope for user uploads generally |
| (f) Do nothing | Live gap ships unchanged | Unchanged | Unchanged | Zero effort | Unchanged | Reject — the gate dimension is already failing in production |

### Recommendation

**Adopt (c) — one-step, entity-attached upload — as the default pattern**, replacing the tenant-less
temp table for every surface where the parent record already exists at attach time; treat **(b) —
direct-to-S3 presigned PUT — as the follow-on optimization** once (c) is stable, not simultaneous.
Reject (d)/(e) as core-architecture changes now. Not because (c) is the textbook-purest answer (that's
arguably (b)) — but because it's already proven correct in this exact codebase (ticket attachments: the
one fully-working, tenant-scoped, real-delete flow in the whole survey) and needs no new infrastructure,
just applying a pattern that already exists uniformly instead of only for tickets. `FilesHelper` is not a
"keep and improve" candidate — dead, unreachable, strictly worse contract on the same domain table;
delete it, don't architect it in.

### Change now / improve later / watch in prod

**Now:** remove or properly gate the two unscoped delete endpoints; add a tenant column to
`temporary_files` and scope every lookup against it; delete `FilesHelper`; fix the ticket-form's
commented-out link call; fix the mobile FormData double-append and the document-picker filename bug.

**Later:** migrate every surface uniformly to the one-step pattern; add a TTL+sweep job for staged files;
move validation to ingestion time, not link time; add a client-side upload timeout + visible error +
retry on mobile; plan direct-to-S3 once (c) stabilizes; wrap inbound email attachments in an async
scan/hold step; re-enable (or decide on) the four commented-out client-side size checks; fix
`generatePreSignedUrl`'s literal-error-string failure mode.

**Watch:** quota-race overshoot per tenant; S3 object-count/cost growth in temp/trash prefixes as a
sweeper-health signal; `Files` rows with `isActive=true` pointing at 404ing S3 keys; mail-attachment
key-collision overwrites.

### Open questions

Whether the global Spring Security filter chain requires auth beyond method annotations (confirmed: yes,
it does — see Errata #5); whether any rate limit exists in front of `/temp/upload` (not found, flagged
unverified); the real team/timeline capacity for migrating every surface to pattern (c); whether
`FilesHelper` was left in place for a near-term feature not yet built, or is simply forgotten.

---

## 2. Decision-Making Agent — should this architecture change?

*(Full methodology: `CLAUDE-decision.md`. Same subject matter, decision-framed with explicit
right-sizing and real-world-issue handling.)*

### The real decision

Not "is multipart-to-backend-then-S3 acceptable" (it is) — the real question is *which shape* of the
upload lifecycle (one-step vs. two-step, validated-when, tenant-scoped-when, one storage backend or two)
is correct, given the current implementation has a live tenant-isolation hole, an unvalidated write path,
and two competing delete/storage mechanisms already shipped side by side. Constraints: hard multi-tenant
isolation requirement (violated structurally on one table); the real, unvalidated ingestion endpoint
(Errata #1); default 1GB company quota that real receipt-photographing tenants will hit routinely; zero
scheduled reaping of abandoned uploads; two mobile apps (one wired, one not) plus a web portal, on real
cellular connections, no timeout/retry anywhere; and a team that has already shipped both a working
one-step pattern (tickets) and a dead second storage pipeline (`FilesHelper`) — evidence about what this
team can and does build, used to calibrate the right next step rather than the theoretical ideal.

### Approaches (including a hybrid not considered by the critic pass)

1. Current as-is. 2. Direct-to-S3 presigned PUT. 3. One-step upload-and-link. 4. Chunked/resumable
upload. 5. Async outbox+worker. 6. Simplest anchor — kill the temp stage entirely, require the parent
record to exist first. 7. Heaviest anchor — dedicated media-asset microservice. **8. Hybrid** — keep a
*tenant-scoped, validated* temp stage only for the genuine "attach before the parent record exists" case
(new docket, new ticket, new company logo); migrate every "parent already exists at attach time" flow to
the one-step pattern; have promotion reuse the same validation function raw upload should use, instead of
a parallel one. Sub-decision: `FilesHelper` — keep as a second pipeline, or retire.

### Why each beats/loses to the others (condensed matrix — full reasoning in the source report)

| Approach | Tenancy fixable in place? | Validation timing | Mobile/offline fit | Team lift now |
|---|---|---|---|---|
| 1. As-is | No — no column to key off | Only at promotion, and only if the user saves | Silent failures, no timeout, duplicate-fire on double-tap | None |
| 2. Presigned-PUT | Yes, new race to manage | Must move client-side or re-add a server round-trip | New client-side S3-multipart logic in 2 RN apps + web | High |
| 3. One-step | Yes — inherits the entity's existing check | At/before the same transaction as the write | Same request shape as today | **Already built** (tickets) |
| 4. Chunked | N/A | N/A | Solves a problem this app doesn't have | High |
| 5. Async scan/worker | N/A | Delays "commit" until worker finishes | Adds a "processing…" state to render | High |
| 6. No temp stage | Trivially yes | Same transaction, always | Breaks the real "attach before Save" UX every surface relies on | Forces a bigger behavior change than hardening the stage |
| 7. Microservice | Yes, by construction | Configurable | Over-built | Very high |
| **8. Hybrid** | **Yes** | **Validated at raw upload, not deferred** | **Same shape, hardened** | **Low–medium** |

**Winner: 8.** Fixes the two real defects without discarding the genuinely-needed "attach before save"
UX, reusing a pattern (3) this team has already shipped once, rather than a wholly new transport (2) or
async infrastructure (5) the app doesn't need at these file sizes/threat model.

**`FilesHelper` sub-decision: retire.** Verified zero reachable callers — not "a pipeline serving traffic
that needs migrating," pure dead weight that bypasses every validation and tenant check on the same
table, one accidental future wiring-up away from becoming live risk again.

### Real-time stress test (hybrid)

Holds on the happy path, concurrency (once tenant-scoped), and cascade (downstream consumers only ever
see a `fileKey`/presigned URL, unaffected by which upload shape produced it). Does **not** hold "for
free" on: partial failure mid-upload (same orphan risk as today, needs a reconciliation job regardless of
which shape wins); retry/at-least-once (needs an explicit idempotency key, independent of this decision);
offline/reconnection (still no queue needed at this file-size scale, but failure must become *visible*,
which it isn't today on mobile); the live-SUM quota check (not fixed by the hybrid alone — needs its own
hardening, see below); abandonment (needs an explicit TTL reaper — the single biggest gap neither
"current" nor "hybrid-without-a-reaper" survives).

### Decision

Confirmed: **the current architecture is the wrong shape to keep unmodified, but the fix is hardening
plus a scope migration, not a wholesale transport replacement.** Concretely: keep backend-mediated
multipart upload (reject presigned-PUT for now — file sizes here don't justify moving validation off the
server); fix the temp stage rather than deleting it (add the tenant column, move validation to raw-upload
time); migrate "parent exists at attach time" surfaces to the one-step pattern, keeping the two-step shape
only for genuine pre-save-creation flows; reject chunked upload and async scan/transcode as unneeded
machinery right now; retire `FilesHelper` entirely; consolidate the delete mechanisms into one.

**What this gives up:** no offline upload queue, no resumable/chunked transfer, no virus-scanning, no
single-call-always uniformity (the two-step shape stays deliberately for pre-save attach flows). All
stated as conscious omissions, not oversights.

### Real-world issues & handling

- **Tenant-isolation gap** → add `company_id` to `temporary_files`, populate from the authenticated
  principal (never client input), enforce on every lookup, mirroring the pattern permanent-file lookups
  already use correctly.
- **Quota TOCTOU race** → replace the live `SUM` with a maintained counter, updated via a single guarded
  `UPDATE ... SET used = used + :delta WHERE used + :delta <= allocated` — a single-row conditional
  update, not distributed locking; also fixes the query's scale problem for free.
- **Ungated raw upload** → move the existing (already-written) `CommonUtils` validation calls to run
  inside the raw-upload method itself, using the newly-required tenant id for the quota check.
- **Abandonment/orphans** → a scheduled TTL-based sweep (reusing the existing `@Scheduled` pattern
  already in this codebase) for unlinked temp rows/objects past 24–48h.
- **Partial-failure orphans on the permanent path** → generalize the same sweeper to detect
  DB-row/S3-object mismatches on a grace period, log for alerting rather than silently auto-deleting live
  references.
- **Retry/duplicate uploads** → a client-generated idempotency key per file-pick, deduped server-side in
  a short window.
- **`FilesHelper` retirement risk** → confirm via a production log/metrics check that it's never invoked,
  and check whether its BLOB column has any existing rows needing a one-time backfill to S3 before
  dropping the pipeline.
- **The two/three competing delete mechanisms** → the highest-severity single item in the whole review;
  fix independent of everything else's sequencing, since it needs no schema change, just a
  `@PreAuthorize`/company-filter fix mirroring code that already exists two methods away.

### Right-size check

Not over-engineered: explicitly rejects presigned-PUT, chunked/resumable transfer, and async
scan/transcode infrastructure — none of the traced file sizes or requirements demand them. The quota fix
is a single atomic UPDATE, not a distributed lock. The abandonment fix is one scheduled sweep, not an
event-driven pipeline. Not under-engineered: the tenant-isolation gap, the ungated raw-upload path, and
the unlocked quota race are real correctness/security stakes for a multi-tenant SaaS, and "just add a
WHERE clause" isn't available — the column doesn't exist. A schema change plus moving already-written
validation earlier is the minimum that actually closes the gaps, not a token gesture.

### Next steps / open questions

Build now: disable/gate the unauthenticated hard-delete-by-id first (independent of everything else, do
it today); add the tenant column; move validation into raw upload; atomic quota counter; TTL reaper.
Build soon: migrate ticket-form and other pre-existing-record surfaces to the one-step pattern; fix the
mobile FormData bug and missing disabled-guard; confirm and retire `FilesHelper`. Monitor: storage-usage
growth rate, reaper deletion volume, quota-rejection rate at raw-upload time (expect a one-time
visibility bump, not a regression). Open questions: does `Files.fileData` have existing production rows
needing migration before `FilesHelper` deletion; any roadmapped virus-scan/transcode requirement; any
file type approaching Spring's 20MB cap; the S3 bucket's own lifecycle policy on the temp prefix
(unverifiable from the application repo alone); team capacity/compliance sign-off cycles for the schema
migration.

---

## 3. Enterprise Backend Standard — checklist review

*(Full methodology: `CLAUDE-backend-standard.md` §13. Scope: the `ayphen-3.0` backend implementation
only.)*

### Module / pipeline / transaction / isolation map

Modules: `FilesController` (transport) → `FilesServiceImpl` (business logic + S3 orchestration,
class-level `@Transactional(rollbackOn = Exception.class)`) → `CommonUtils` (validation, called
inconsistently — see P0-2) → `ConversionUtils` (DTO mapping, presigned-URL generation) →
`FilesHelper` (second, unreachable pipeline) → `AwsS3Config` (S3 client/presigner beans, no
timeout/retry override) → `FilesRepository`/`TemporaryFileRepository` (JPA). Security: Spring's
blanket `.anyRequest().authenticated()`, with `@PreAuthorize` present only on the `/tenant/{tenantId}/...`
route family. No rate-limit stage, no request-validation stage beyond a few `@Valid` DTOs on the
tenant-scoped routes, no response-transform/correlation-id stage anywhere in this pipeline.

Two isolation models coexist in the same `files` table: the tenant-scoped model (correct — resolves
`companyId` once from the authenticated `tenantId` and threads it through every query) and the
numeric-id model (broken — `/upload`, `/update/{id}`, `/delete/{id}` operate on a bare id with no
company predicate anywhere). `temporary_files` has no tenant column at all — isolation is structurally
impossible there, not just unenforced. `FilesHelper` has zero tenant filtering on any lookup, but is
confirmed unreachable from any controller.

### Findings, P0 → P3

**P0-1 — The global exception handler cannot catch real exceptions (verified via bytecode).** Custom
classes in the same package as `GlobalExceptionHandler` share names with `Exception`/`IOException`/
`IllegalArgumentException`/`IllegalStateException`, winning Java's same-package resolution over the JDK
types those handler methods are meant to catch. Confirmed by decompiling the compiled class — none of
the four handlers ever catch the real JDK exceptions actually thrown throughout this feature (e.g. a
genuine `java.lang.IllegalArgumentException` at `FilesServiceImpl.java:717`). *Fix*: rename the colliding
custom classes or delete them if unused elsewhere; add an explicit, fully-qualified `java.lang.Exception`
handler; add a regression test asserting the response envelope on a thrown plain `RuntimeException`.

**P0-2 — The endpoint every real upload hits performs zero validation** (see Errata #1 in the flow doc).
*Fix*: make the existing `validateTempFileUploadRestrictions` function the mandatory gate on raw temp
upload, resolving/requiring a tenant id at that point rather than deferring to promotion.

**P0-3 — Hard delete-by-id has no tenant filter.** `findByIdAndIsActiveTrue(id)` with no `companyId`
predicate; any tenant can flip another tenant's file inactive and physically delete it from S3, with no
recovery path. *Fix*: require and filter by the caller's resolved `companyId`, or remove the endpoint.

**P0-4 — Temp-file delete/soft-delete has no tenant scoping — structural.** No column exists to filter
on. *Fix*: add a `company_fk` column, populate at upload time, filter every lookup by it.

**P1-5 — Storage quota check is check-then-act with no locking (TOCTOU).** A plain `SUM` read compared
against the allocation, no lock, no atomic claim. *Fix*: a maintained, atomically-updated `used_size`
column, claimed via a single guarded `UPDATE`.

**P1-6 — S3 client has no timeout/retry configuration, and the S3 call runs inside the DB transaction.**
Pure SDK defaults; a slow/hanging S3 call holds an open DB connection for the full duration of an
effectively unbounded external network call — under load, S3-side slowness alone can exhaust the
connection pool. *Fix*: set `apiCallTimeout`/`apiCallAttemptTimeout`; restructure so the S3 call doesn't
hold a DB connection open.

**P1-7 — S3/DB dual-writes are never reconciled, confirmed in three places (one new).** Create (S3
before DB insert — orphan on insert failure); update (old object deleted before new upload — an active
row can point at nothing); **delete — new finding**: a batch delete loops over multiple keys inside one
shared transaction, catching only one specific exception type per key; a later key's raw S3 exception
rolls back the whole transaction, but the S3 deletes already executed for earlier keys in the batch are
not undone, leaving DB rows "active" pointing at S3 objects already gone. No reconciliation job exists
for any of the three cases. *Fix*: one consistent write order, driven by a durable pending/committed
status; widen exception handling per key so one bad key can't roll back already-succeeded ones.

**P1-8 — Presigned-URL failure path returns a fake "URL" and logs via raw stdout.** Logs via
`System.err.println` (invisible to any centralized log pipeline, no request context) and returns the
literal string `"Error generating pre-signed URL"` as if it were a real URL — every consumer that renders
this field directly silently shows/stores a broken link. *Fix*: log through the real logger; return
`null`/rethrow instead of a string masquerading as success.

**P2-9 — `FilesHelper` is confirmed dead code.** Zero controller call sites for any of its eight exposed
methods. *Recommendation*: delete it — one hardened pipeline, not two.

**P2-10 — Missing indexes on every real hot-query column.** `files` and `temporary_files` are indexed
only on `id` (redundant, already the primary key) and `is_active` (low selectivity alone) — none of
`company_fk`, `record_id`, `entity_fk`, `file_type_fk`, `file_key`, the exact columns every real query
filters on, are indexed. `files_config`'s `is_active` index is present in source but commented out.
*Fix*: composite indexes matching actual query shapes.

**P2-11 — `Files.companyId`'s JPA annotation contradicts the real schema.** Declared `nullable = false`
in the entity, but the DDL allows `NULL` and the service code deliberately inserts `null` when no company
guuid resolves — a silently null-tenant row, invisible to every tenant-scoped query, reachable only
through the tenant-blind hard-delete path. *Fix*: decide deliberately whether this can ever be null; if
not, enforce it at the DB and reject the upload instead of silently proceeding.

**P2-12 — No rate limiting on upload/delete**, despite a working rate-limit mechanism already existing
and used elsewhere in this codebase (email verification, Plaid, transaction verification) — just not
applied here, on the single most expensive operation in this module.

**P2-13 — No correlation/trace-id infrastructure anywhere in the codebase.** Combined with P1-8's raw
stdout logging and P0-1's broken generic handler, a production failure in this feature is genuinely hard
to trace back to a specific request from logs alone.

**P3-14/15 — nits.** Mail-attachment S3 keys lack a UUID segment (deterministic, collision-prone,
confirmed from the flow doc); `files_config`'s `is_active` index is commented out in source, low-severity
easy re-enable.

### Definition of Done — 15/15 items scored

| # | Item | Verdict |
|---|---|---|
| 1 | Transport thin; logic in service; queries in repo | PARTIAL — a sliver of error-shaping logic leaked into the controller for one endpoint |
| 2 | Client never trusted; every tenant query scoped | **FAIL** — P0-3, P0-4 |
| 3 | Multi-step writes transactional; idempotency/audit in the same tx as the effect | PARTIAL — DB writes are wrapped, but the S3 half of every multi-step write has no compensating mechanism, and there's no idempotency key anywhere |
| 4 | Hard invariants backed by DB constraints; limits claimed atomically | **FAIL** — P1-5, plus the attachment-count check is the same pattern |
| 5 | Guards applied, correct order, fail-closed | PARTIAL — genuinely applied on tenant-scoped routes, entirely absent on the routes that matter most |
| 6 | Input validated at the boundary; unknown fields rejected | **FAIL** — P0-2 |
| 7 | Errors typed, correct status, consistent shape, none swallowed | **FAIL** — P0-1, plus a confirmed case where HTTP 200 is returned for a body that says 404 |
| 8 | Timeouts on outbound calls; retryable side-effects idempotent; lists paginated | **FAIL** — P1-6, plus at least one fully unbounded list-returning endpoint |
| 9 | One source of truth per fact; caches have a durable backstop | PARTIAL — presigned URLs correctly regenerated at read time, but a redundant, never-refreshed raw URL rides along in every response |
| 10 | Config typed + validated on boot; secrets from a store | **FAIL** — no boot-time validation of AWS config; plaintext DB/SMTP/OAuth secrets committed directly in resource files |
| 11 | No N+1; indexes cover frequent queries; migrations safe/reversible | **FAIL** — P2-10, no migration tool, at least one confirmed per-row N+1 in DTO conversion |
| 12 | Observability: correlation ids, critical-path metrics, audit | **FAIL** — P2-13, P1-8 |
| 13 | Resilient: timeouts, retries+backoff, graceful degradation/shutdown | **FAIL** — P1-6, no graceful-shutdown config found, no circuit breaker around S3 |
| 14 | Right-sized — no needless abstraction; no under-hardened safety path | **FAIL, on both extremes simultaneously** — a dead second pipeline (over-built) coexisting with a zero-validation production ingress point (under-built) |
| 15 | Risky logic tested (auth, concurrency, tenancy, idempotency) | **FAIL, unambiguously** — two test files exist in the entire repository, neither covering this feature |

### What's genuinely well-built — preserve this

The tenant-scoped `/tenant/{tenantId}/...` route family is correctly built end to end and should be the
template every other gap gets fixed to match, not the reverse. Presigned URLs are generated fresh at
read time, never cached/stored — exactly right per "cache is a fast path, not the source of truth." The
mail-attachment batch upload's partial-success design (log per-file failures, don't abort the batch) is a
deliberate, sensible choice for a multi-item batch. The six `CommonUtils` validation checks are genuinely
thorough where they're actually wired up — their problem is reach (P0-2), not design. `ACL.PRIVATE` on
every S3 write plus presigned-GET-only reads is the correct default. The class-level `@Transactional`
correctly resolves to the real `java.lang.Exception` in this specific file (a different import-resolution
outcome than the exception-handler bug — it isn't affected by the same collision).

---

## 4. Senior Backend Architect — architecture-level design review

*(Full methodology: `CLAUDE-backend-architect.md`. Scope: the `Files`/`TemporaryFile`/`FilesConfig`/
`CompanyStorageAllocation`/`StorageArea` data model and the storage architecture built on it.)*

### Problem & constraints

A multi-tenant B2B SaaS needs to attach business documents to nearly every domain entity, upload from
thin clients (mobile, web, inbound email), keep them private per tenant, enforce a paid storage
entitlement, and support delete/restore without accidental permanent loss. Non-functional drivers:
multi-tenancy is a hard invariant everywhere except one table (the structural outlier); blast radius is
large — this is load-bearing plumbing for the majority of the domain model (~90 call sites across nearly
every transaction/domain service), not a niche feature; scale is moderate (tens to low hundreds of
concurrent uploads per company), not hyperscale; the DB row is already correctly the source of truth,
S3 is correctly a dumb blob store; evidence of a small team iterating quickly (copy-paste patterns, a
partial implementation, dead code) rather than a platform team, meaning fixes must be incremental, not a
rewrite.

### Dominant forces

1. **Security/tenant-isolation vs. genericity.** The module's power is serving ~90 call sites through one
   generic, polymorphic implementation — a real win. But genericity plus one table with no tenant column
   means the isolation guarantee that holds everywhere else in this schema silently doesn't hold here.
   The fix must preserve the one-implementation genericity while restoring the isolation invariant.
2. **Correctness-under-concurrency vs. simplicity on the quota check.** The live unlocked `SUM` read
   gating a hard entitlement is the canonical "check-then-insert on a limit" anti-pattern. The
   counter-force: quota overage here is a soft consequence (a billing correction, not lost inventory or
   double-spent money), so the fix must be proportionate, not a distributed reservation system.

### Designs considered (five axes, each with simplest/heaviest anchors)

**A — pipelines**: A1 keep both (formalize `FilesHelper`), A2 collapse to one, A3 harden both behind one
contract. **B — temp-file tenancy**: B1 leave as-is (rely on key unguessability), B2 add a tenant column,
B3 eliminate the temp/permanent split entirely. **C — delete**: C1 leave both mechanisms, C2 retire the
unscoped hard-delete for one tenant-scoped soft-delete-to-trash + scheduled purge, C3 a full
state-machine approval workflow. **D — the polymorphic pointer**: D1 leave as-is, D2 keep it but add
compensating controls (a guarded write helper + an orphan-audit job), D3 a per-entity FK table per
consumer, D4 a document-store side table. **E — read side**: E1 presigned-at-read (current), E2 cached
signed URLs, E3 CDN, E4 backend streaming proxy. **F — quota concurrency**: F1 live unlocked SUM
(current), F2 `SELECT ... FOR UPDATE`, F3 an atomic counter column, F4 a reservation/hold pattern.

### Stress test (condensed — full per-cell reasoning in the source report)

- **A1/A3 fail** the trust-boundary test: `FilesHelper` bypasses every validation/tenant check and is one
  accidental controller-wiring away from live risk, for zero present benefit (zero callers today). **A2
  holds.**
- **B1 fails** trust-boundary decisively — confirmed the impact is *wider* than delete alone: the
  promotion/link path and the generic delete branch used by ~90 callers both share the same unscoped
  lookup, because the column doesn't exist to filter on. **B2 holds**, additive and backward-compatible.
  **B3 is correct in principle but its migration blast radius — touching every one of ~90 callers' commit
  semantics simultaneously — is disproportionate** to the actual defect.
- **C1 fails** outright (unauthenticated, unscoped, irreversible). **C2 holds** and matches this app's
  actual need (a trash-and-restore UX, not a compliance approval gate — **C3 rejected** as solving an
  unstated requirement).
- **D1** leaves the write-time invariant-enforcement gap unaddressed. **D2 holds** — the right amount of
  architecture for a polymorphic association: makes violations detectable and rebuildable rather than
  DB-prevented, which is the correct trade when the underlying fact is cheap to notice and cheap to
  repair. **D3 rejected** — ~90 join tables directly contradicts the reason this design exists. **D4
  rejected** — a second datastore for data that's fundamentally relational.
- **E1 holds** at this app's actual scale — signing is a local cryptographic operation, not a network
  round trip, and the short (35-min) blast radius on a leaked URL is a *good* property, not a gap. **E2/E3
  are premature optimization** for a fan-out problem (thousands of concurrent readers per object) this
  workload doesn't have. **E4 rejected** — trades a bottleneck that doesn't exist (signing cost) for one
  that would (app-tier byte-buffering under load).
- **F1 fails** — confirmed lost-update race, plus a secondary, independent scale problem (the SUM scan
  gets linearly more expensive as a company's file count grows). **F2 holds** as a minimal-diff interim.
  **F3 holds and is the winner** — closes the race *and* removes the scan cost with one mechanism. **F4
  rejected** — disproportionate machinery for a limit whose overage consequence is a billing correction.

### Decision

**A2** (collapse to one pipeline, delete `FilesHelper`) · **B2** (add the tenant column, don't eliminate
the temp/permanent split) · **C2** (one tenant-scoped soft-delete-to-trash path + scheduled purge) · **D2**
(keep the polymorphic pointer, add a guarded write helper + orphan-audit job) · **E1** (keep
presigned-at-read, no cache/CDN/proxy) · **F3** (atomic counter column for quota, with F2 as an
acceptable interim if the schema migration can't ship immediately). Each decision's concrete
per-alternative reasoning is in the stress test above; none of these are "textbook best practice
regardless of context" — each is justified against this system's actual blast radius, scale, and team
signal, and each states explicitly what it gives up (see the source report for the full per-decision
"what this gives up" statements).

### The specified architecture (all required elements)

**Boundaries**: one `files` module, one `FilesService` interface, one implementation backend (S3 +
Postgres). Stays a module inside the monolith — nothing about consistency needs or team structure argues
for service extraction; a network hop between "attach a file" and "the entity being attached to" would
turn a local transaction into a distributed one for no stated benefit.

**Data architecture & authority**: `files` remains the one source of truth for "this file exists and is
linked here," `company_fk` tightened to `NOT NULL`, validated at write time through one shared helper
rather than scattered `save()` calls. `temporary_files` gains the tenant column, ephemeral by design
(minutes to hours). `files_config` unchanged — the one table in this cluster that already has real DB
referential integrity, because it isn't polymorphic. `company_storage` gains a materialized
`used_size_kb` counter, backfilled once from the existing SUM, which remains available as the
reconciliation source of truth if the counter ever drifts.

**Consistency & transaction model**: replace the current class-level transaction wrapping S3 network
calls with an explicit two-phase commit-by-status pattern — short transaction to insert
`status=PENDING`, S3 I/O outside any DB transaction, short transaction to flip
`COMMITTED`/`FAILED`. No queue or saga needed. This single mechanism fixes the create-path orphan, the
update-path dangling-reference ordering bug (additionally: reorder update to upload-new-first,
swap-the-pointer, delete-old-after-commit), and gives a new reconciliation sweeper one simple query to
run.

**Concurrency control**: atomic guarded `UPDATE` for the quota counter; the same pattern deferred (not
built preemptively) for per-record consolidated-size/attachment-count checks unless a specific entity
type shows real contention; everything else stays plain row-level, since once the tenant-scope and quota
fixes land there's no other shared mutable aggregate being raced.

**Idempotency & retry**: the `temporary_files` row's existence plus the new status column is the dedupe
key for "has this already been promoted" — a retried promotion for an already-committed key is a no-op,
not an error. Recommend the raw-upload endpoint accept an optional client-generated idempotency key (or a
short-window `(company, entity, record, file-hash)` fallback dedupe) so a client-side retry doesn't
silently create and bill for a duplicate file.

**Failure semantics**: partial failure at any step leaves a row in `PENDING`/`FAILED`, never `COMMITTED`
with a missing/wrong object. A new lightweight scheduled sweeper (matching an existing pattern already
in this codebase) reaps stuck rows past a grace window and cleans up any half-written S3 objects.
Caller-visible behavior: endpoints return success only after the status flips to `COMMITTED`.

**Security & isolation**: every read/delete/promote call filters by the caller's resolved `companyId`
through one shared access helper, not ad hoc per-method `findBy...` calls — the current inconsistency
(some paths filter, some don't, by omission) is itself more the root cause than any single endpoint.
Fail-closed default: any resolution failure rejects the operation rather than silently proceeding with a
null company, which the current code explicitly does today.

**Contract surface**: `FilesService` shrinks by the eight `FilesHelper`-backed methods — breaking in
name only, since nothing calls them. Public HTTP contract otherwise unchanged in shape; the numeric
hard-delete route retires per C2; the currently-dead `DELETE /temp/upload` route (zero frontend callers)
either gets wired up as the "cancel my in-progress upload" action the UX is missing, or removed —
leaving a defined-but-uncalled endpoint on a public contract is a small instance of the same
"coexisting mechanisms" smell being fixed elsewhere.

**Scale path**: nothing here needs partitioning, caching, or a CDN at today's implied scale. The one
component that would need attention at 10x — the quota check — is already solved in advance by moving to
the atomic counter, O(1) regardless of a company's total file count versus the current full-table scan.

**Operational surface**: log/alert on sweeper run duration and reconciled-row count; quota-rejection
rate per company; presigned-URL failure rate (should be near zero once it fails closed); mail-attachment
key-collision events (near-zero once the deterministic key is fixed). No new external dependency
introduced — S3 and Postgres are already covered by existing health checks.

**Evolution**: one-way doors — the `temporary_files` schema change (cheap and additive, but roll out
carefully since it touches the shared helper ~90 call sites depend on); removing `FilesHelper` from the
public interface (safe once the zero-caller finding is reconfirmed at ship time); retiring the
hard-delete-by-id endpoint (confirm no hidden internal tooling calls it directly first). Two-way doors,
safe to iterate: the status column and sweeper cadence, the quota counter's backfill logic, presigned-URL
expiry duration.

### Failure modes & guardrails

1. **Cross-tenant file adoption/deletion via `temporary_files`** — the single most important finding of
   this whole review, broader than delete alone (also reaches promotion and the generic ~90-call-site
   delete branch). Guardrail: the tenant column plus a regression test asserting every lookup includes a
   company predicate. Monitor: "temp file not found" error rate post-fix (expected to rise — cross-tenant
   guesses now correctly fail, versus silently succeeding before).
2. **Quota race under concurrent uploads near a company's cap.** Guardrail: the atomic guarded UPDATE.
   Monitor: rejected-upload rate per company, distinguishing genuine-over-quota from raced-and-lost
   (which should now retry cleanly).
3. **Torn upload/edit/trash-move leaving orphaned objects or dangling references, with literally no
   cleanup mechanism today** (confirmed — no scheduled job anywhere touches files/S3/storage). Guardrail:
   the status column + sweeper. Monitor: sweeper's per-run cleaned-row count, alerting if it trends
   upward rather than staying near zero.
4. Lower-severity, one-line fixes: `generatePreSignedUrl`'s fail-open error string; the mail-attachment
   deterministic-key collision.

### Build order & what to defer

**Now**: tenant column on `temporary_files` + fix the three call sites (highest severity, smallest diff);
retire the numeric hard-delete endpoint (confirm no internal tooling depends on it first); delete
`FilesHelper` (confirm no out-of-repo caller first); add the quota counter and switch the check to it;
fix the presigned-URL fail-open string and the mail-attachment key collision.

**Soon, not urgent**: the status-column + sweeper job; the update-path reorder. The current failure mode
here is a slow leak on rare partial failures, not an active exploit path the way tenant-scoping is —
sequence after the security fixes.

**Explicitly deferred, with the trigger that would change the call**: per-record atomic counters (defer
until a specific entity type shows real contention); CDN/signed-URL caching/streaming proxy (defer until
a measured bottleneck, e.g. a single view rendering hundreds of attachments); a reservation/hold pattern
for quota (defer indefinitely unless overage stops being a billing-correction problem and becomes a hard
capacity/compliance constraint); collapsing the temp/permanent tables into one (defer indefinitely — the
tenant-column fix solves the actual defect at a fraction of the migration cost).

### Open questions

Whether `FilesHelper` is truly unreachable from anything outside this repository (a batch job, an admin
tool, a sibling service not in scope) — lean toward a brief warn-if-invoked deprecation period before
hard removal, given the module's demonstrated blast radius elsewhere; actual current tenant count and
peak concurrent-upload rate per company, to calibrate whether the F2 interim step is needed before F3
ships or whether the race is rare enough to go straight to F3; whether `fileKey` values are ever exposed
across a trust boundary in practice (support tooling, log aggregation) — treated here as "leak channels
exist in principle, therefore fix regardless," but real incident data would sharpen the urgency; whether
existing operational tooling already relies on the numeric hard-delete endpoint as an intentional admin
action, requiring a scoped replacement rather than a straight removal; the appropriate trash retention
window before physical purge — a product/compliance decision, not an architectural one.
