# Product Image — Offline-First Architecture (Reconciled, Consolidated)

> **The single authoritative architecture for offline-first product images in this repo.** It
> reconciles three inputs into one decided design:
> - `docs/mobile/product-image-offline-implementation-plan.md` — the offline-first *intent* (capture
>   offline, deferred background upload, local-first display).
> - `docs/backend/image-upload-architecture.md` — the file-upload *target* (Part C), **now built** in
>   this repo as the NestJS `files` feature (`apps/backend/src/files`).
> - The offline **sync engine** already in the app (`apps/mobile/src/core/sync`) — the JSON mutation
>   queue + delta pull that product creation already rides.
>
> It is written through the three decision lenses in `docs/agent/` (Critic / Flow-Design / Decision):
> every claim about current behaviour is grounded in code (`file:line`), every "should be" is labelled
> target, every choice is decided against alternatives and stress-tested against the real-time
> scenario space — not just the happy path.
>
> **How to read this.** **Part A** is the system *as built today* (the online `files` pipeline + the
> offline JSON sync engine, and the gap between them). **Part B** is the gap/divergence register —
> including where the offline *plan* diverges from what was *built*, ranked. **Part C** is the decided
> offline-first target: the transport decision, the reconciled data model, the confirmed flow, its
> behaviour in every scenario, and the build order.
>
> ---
>
> **Revision 2 — review fixes applied.** A critical review of Revision 1 found four defects and two
> internal inconsistencies, all in the **read path** and the **failure paths** — the two places this
> class of design actually breaks. All are now fixed in-place and are traceable:
>
> | # | Defect | Fixed in |
> |---|---|---|
> | **D1** | `expo-image` disk cache is defeated by rotating presigned URLs (cached by URL) — every grid render re-downloaded | B2/P1-9, C2-D2, C5, C10 |
> | **D2** | Product grid on a non-capturing device = **N HTTP calls** (read endpoint takes a single `record_guuid`) | B2/P1-10, C2-D2, C5, C8 |
> | **D3** | **Infinite defer loop** when the parent product's mutation permanently fails (dead-letter) | B2/P1-11, C4, C5, C6 |
> | **D4** | `commit` never verifies the parent exists; **no orphan-`files` reaper** (sweeper reaps temps only) | B2/P1-12, C3, C5, C7 |
> | **I1** | C6 promised double-tap collapses to one file, but the mechanisms were *optional* in C3; and two *different* photos never dedupe | P2-11 → **P1-13 (mandatory)**, plus capture-button lock |
> | **I2** | `files_config` seed for `(Product, image)` was an "open question" but is **build-blocking** | C8 **Step 0** |
>
> **D4 is the highest-value change:** making `commit` verify the parent converts three separate
> client-side *courtesies* (defer-until-synced, orphan guard, no-phantom-rows) into one **server-enforced
> invariant**.
>
> ---
>
> **Revision 3 — the feature is now BUILT.** The Part C offline-first target has been implemented
> end-to-end. **Read Part C as the *as-built* architecture, not a to-be target** (and Part A's "the gap
> / not built yet" statements as *historical* — the gap is closed). Where Part C says "REQUIRED — … to
> build," read the status table below. Build status, grounded in code:
>
> | Part C item | Status | Where (as-built) |
> |---|---|---|
> | Local `attachment` table (C3) | ✅ Built — matches proposed schema 1:1 (21 cols, both indexes, 8 status values) | `apps/mobile/src/core/sync/db/schema.ts:318-364`, migration `db/migrations/0006_unknown_meggan.sql` |
> | Background uploader (C4/C5) | ✅ Built | `apps/mobile/src/core/sync/image-uploader.ts` (`MAX_CONCURRENT=2`, `MAX_UPLOAD_ATTEMPTS=8`, `MAX_DEFER_ATTEMPTS=60`) |
> | Capture flow + capture-control lock (C5-0) | ✅ Built | `features/attachments/offline/persistCapturedImage.ts` (downsize 1200@0.8, thumb 300@0.7), `useRecordImageCapture.ts` (`isCapturing` lock), `ProductImageCaptureField.tsx`, `CreateProductScreen.tsx` (Save never awaits the image) |
> | Display component (C5) | ✅ Built | `features/attachments/offline/RecordImage.tsx` (stable `cacheKey = file guuid`, thumb→remote→initials order, upload-state badges), `useRecordImage.ts` (reactive `useLiveQuery`) |
> | commit parent-verify → 409 (P1-12a) | ✅ Built | `files/record-existence.service.ts` (registry = **`Product` only**), `files/files.service.ts` commit(); wire code `file_parent_not_found` |
> | orphan-`files` reaper (P1-12b) | ✅ Built (cron) | `files/orphan-files-reaper.service.ts` |
> | `(record_guuid, sha256)` partial-unique (P1-13) | ✅ Built | `uk_files_record_sha`, migration `drizzle/0032_files_record_sha_dedupe.sql` |
> | Batched grid read (P1-10) | ✅ Built (endpoint + client repo), ⚠️ **not yet consumed by a grid screen** | `GET stores/:storeId/files/by-records` (`files.controller.ts:116`), `attachment.repository.ts findByRecordGuuids`; only the create-form renders `RecordImage`, without `remoteFile` |
> | `files_config` seed / `supports_attachments` (Step 0) | ✅ Built (entity-wide rule, `file_kind = null` — not a `(Product, image)`-specific row) | `seed.ts:497-529`, `entity-catalogue.ts:22` |
> | Subscription bulk-requeue of `blocked` (P1-14) | ✅ Built — **client-driven** (network interceptor on the `x-subscription-version` header bump), not a server trigger | `attachment.repository.ts requeueBlocked`, `core/network/interceptors.ts` |
> | Reads exempt from subscription write-gate | ✅ Built | `subscription-status.guard.ts` `READ_METHODS` |
> | stage object write OUTSIDE the DB tx (P2-15) | ✅ Built | `files.service.ts` stageUpload (put → insert, no tx) |
> | Per-S3-call timeout (P2-15) | ❌ **Not built** — only a global 30s request timeout; a tighter per-call timeout is an acknowledged follow-up | `s3-storage.provider.ts` |
> | `Product:edit` per-parent permission on files routes | ❌ **Not built** (deferred — C11 open #1) | `files.controller.ts` |
>
> **Behaviour divergences from the earlier design text (the code is the source of truth):**
> - **Premature-commit gate.** `isParentApplied` treats a **missing** create mutation as *not* applied →
>   **defer** (not "assume pre-existing"). Since product images are only captured against a brand-new
>   draft, `stage` + `commit` fire **only after the product's create mutation has synced** — this is what
>   eliminated the spurious `409 file_parent_not_found` on capture.
> - **`file_parent_not_found` → `deferOrOrphan`**, not a direct `orphaned`: it defers while the parent's
>   create is still in-flight and orphans only when that create is terminal — more nuanced than C5's
>   original "→ orphaned."
> - **Error codes are matched lowercase** (`file_parent_not_found`, `temp_file_expired`, and
>   `startsWith('subscription')`) — they arrive as snake_case wire codes, not the UPPER_SNAKE constant names.
> - **Batched read is a dedicated `/files/by-records` sub-route** (map response, cap 100), not a
>   `?record_guuids=` param on the base list route.
> - **Recent hardening (this build):** S3 `copyObject` now encodes each `CopySource` path *segment* while
>   preserving `/` (Supabase's gateway doesn't decode `%2F`), and logs the underlying error instead of a
>   bare 503; the uploader is re-woken *after* a sync cycle completes so a just-synced record's image
>   commits promptly.

---

## Table of contents

- **Part A — Current architecture (as-built)**
  - A1. System context & the two transports that already exist
  - A2. Data model as-built (server + local)
  - A3. The online file pipeline as-built (stage → commit → read → delete)
  - A4. The offline sync engine as-built (JSON rows)
  - A5. API / contract surface as-built
  - A6. The gap: online binaries vs offline records
- **Part B — Gap & divergence register**
  - B1. Where the offline *plan* diverges from what was *built* (errata)
  - B2. Findings, ranked P0 → P3
- **Part C — Target architecture (to-be)**
  - C1. The decision, in one paragraph
  - C2. Decision analysis — transport & cross-device visibility (the critic work)
  - C3. Target data model & authority (server reuse + local SQLite)
  - C4. The attachment state machine (client-owned)
  - C5. The confirmed offline flow, step by step
  - C6. Behaviour in every real-time scenario
  - C7. Security & isolation model
  - C8. Build order & what's already done
  - C9. What to defer, with the trigger that flips it
  - C10. Acceptance criteria (traceable) — incl. the Revision-2 defect gates
  - C11. Open questions (and what Revision 2 closed)

---
---

# PART A — CURRENT ARCHITECTURE (AS-BUILT)

## A1. System context & the two transports that already exist

This is an **offline-first POS**. The app already runs on **two independent transports**, and the
whole offline-image problem is about adding a binary to a system whose two lanes were both built for
different payloads:

```
┌──────────────────────────── MOBILE ────────────────────────────┐
│                                                                 │
│  LANE 1 — JSON mutation queue (BUILT, offline-first)            │
│    product/order/stock rows → local SQLite → /sync/delta        │
│    dependency-ordered, cursor-driven, client-guuid parents      │
│                                                                 │
│  LANE 2 — File pipeline (BUILT, ONLINE-ONLY)                    │
│    multipart stage → commit → presigned-at-read list            │
│    store-scoped, subscription-write-gated, no local persistence │
│                                                                 │
│  THE GAP (Rev 1–2) — now CLOSED in Rev 3: a Lane-1 (offline)    │
│  product is bridged to its Lane-2 (online) image by the local   │
│  `attachment` table + background uploader + defer-until-synced. │
└─────────────────────────────────────────────────────────────────┘
```

> **Rev 3:** the bridge below is now built — see the build-status table in the header. The diagram
> preserves the original problem framing; the three "missing" pieces (local `attachment` table,
> background uploader, defer-until-synced) all now exist.

**Actors.** Authenticated store user (picks/captures, views); a second store's user (the isolation
adversary); the background uploader (**now BUILT** — `apps/mobile/src/core/sync/image-uploader.ts`);
scheduled server sweeper (built, reaps abandoned temps); orphan-`files` reaper (**now BUILT** —
`files/orphan-files-reaper.service.ts`).

**Key fact that shapes everything:** an image is a large binary that **cannot ride Lane 1** (the
mutation queue moves JSON rows and is dependency-ordered — a 2 MB blob on 2G would stall a sale from
syncing). So image movement is a **separate transport** regardless of design. That is not a choice;
it is a constraint. The only choice is *which* separate transport and *how* it defers.

## A2. Data model as-built

**Server (`apps/backend/src/db/schema.ts:996-1070`, migration `drizzle/0010`, hardened by
`0031`):** the two-phase model from `image-upload-architecture.md` Part C, **as implemented**:

| Table | Role | Key columns (as-built) | Scoped by |
|---|---|---|---|
| `temporary_files` | Staged, not-yet-linked uploads | `guuid`, `file_name`, `storage_key`, `size_bytes`, `mime_type`, `sha256`, `uploaded_by`, `expires_at`, **`claimed_at`** | **owner** (`uploaded_by`) |
| `files` | Permanent, record-linked (source of truth) | `guuid`, `entity_type_fk`, `record_id` (no FK), `record_guuid`, `store_fk` (nullable), `kind`, `storage_key`, `mime_type`, `size_bytes`, `sha256`, `original_filename`, `is_private` (default true), audit + `deleted_at` | **store** (`store_fk`) |
| `files_config` | Per-`(entity, kind)` rules | `entity_type_fk`, `file_kind` (nullable), `max_file_size_bytes`, `max_consolidated_size_bytes`, `valid_extensions`, `max_attachments_allowed` | FK to `entity_types` |

Notes that matter downstream: **`temporary_files.claimed_at`** is the atomic commit gate
(`files.repository.ts` `claimTemp`); **`expires_at`** drives the sweeper reaper; committed reads are
**always store-scoped**, staged reads **always owner-scoped** (`files.repository.ts` header comment);
there is **no `status` column** — the temp row's existence *is* the pending state; **no
`company_storage` quota table** (limits are per-record via `files_config`). Presigned URLs are
**regenerated at read time** and **never stored** (`files.mapper.ts` never emits `storage_key`).

**Local (SQLite, `apps/mobile/src/core/sync/db/schema.ts`):** product/order/etc. sync tables exist.
**Rev 3 — the local `attachment` table is now BUILT** (`db/schema.ts:318-364`, migration
`db/migrations/0006_unknown_meggan.sql`), exactly the C3 schema (21 columns incl. `status`,
`local_path`/`local_thumb_path`, `temp_guuid`, `file_guuid`, `attempt_count`/`defer_count`/
`next_attempt_at`, `last_error_code`; partial indexes `idx_att_pending` and `idx_att_parent`). It is the
uploader's durable work list, so an app-kill mid-capture/mid-upload no longer loses the image — the row
survives and the uploader resumes it (`resetInFlight` reverts stale `staging`/`committing` on open). It
is **device-local only** — never synced through `/sync/delta`.

## A3. The online file pipeline as-built

Confirmed in `apps/backend/src/files/`:

1. **Stage** (`POST /stores/:storeId/files/temp`, multipart `file` + `entity_type` + `kind`):
   validates **at ingestion** — empty/size/extension + **magic-byte content sniff** (SVG/markup
   rejected); writes the object under `tmp/{userId}/{uuid}/{name}`; inserts a `temporary_files` row
   (owner-scoped) with `expires_at = now + TTL`; returns `{ guuid, preview_url, expires_at, … }`.
2. **Commit** (`POST /stores/:storeId/files/commit`, `{ entity_type, record_guuid, kind, file_guuids[], … }`):
   resolves temps (owner-scoped) → validates record limits (count + consolidated size) → **atomically
   claims** each temp (`claimed_at IS NULL` gate → one concurrent commit wins) → copies staged→committed
   (`{storeId}/{entityCode}/{recordGuuid}/{uuid}/{name}`) → one DB tx inserts `files` rows + deletes
   temps → deletes staged objects; a failure releases claims so a retry works.
3. **Read** (`GET /stores/:storeId/files?entity_type&record_guuid`, `GET …/:guuid`): store-scoped;
   returns a **fresh presigned GET URL (~35 min)** per read; never the raw key.
4. **Delete/restore** (`DELETE …/:guuid`, `POST …/:guuid/restore`): store-scoped soft-delete → trash.
5. **Sweeper** (cron): reaps `temporary_files` past `expires_at` + their objects.

Every route is guarded `MobileJwt → Tenant(param.storeId) → SubscriptionStatus`, and
`SubscriptionStatusGuard` **exempts `GET`/`HEAD`/`OPTIONS`** (`READ_METHODS`) — so **reads are not
blocked by a lapsed subscription**; only writes (stage/commit/delete/restore) are. This already
satisfies the offline plan's "reads never gated" invariant.

**This pipeline is entirely online.** There is no client-side persistence, no retry/backoff, no
background execution — it assumes a live request with connectivity.

## A4. The offline sync engine as-built

`apps/mobile/src/core/sync`: a mutation queue + delta pull. Product creation
(`CreateProductScreen.tsx:30` → `enqueueCreateProduct`) writes a local row + enqueues a mutation;
**there is no server round-trip to await** (the screen's own comment says so). Parents are referenced
by **client-generated `guuid`** — the product has a stable guuid the instant it's created, long
before it reaches the server. This is the hook the image feature attaches to: an image can point at a
product `guuid` that exists only locally.

## A5. API / contract surface as-built

| Endpoint | Method | Purpose | Gate |
|---|---|---|---|
| `stores/:storeId/files/temp` | POST (multipart) | Stage one file | write-gated |
| `stores/:storeId/files/temp/:guuid` | DELETE | Cancel a staged upload | write-gated |
| `stores/:storeId/files/commit` | POST | Link staged temps to a record | write-gated |
| `stores/:storeId/files` | GET | List a record's files (presigned URLs) | read (ungated) |
| `stores/:storeId/files/:guuid` | GET | One file (fresh presigned URL) | read (ungated) |
| `stores/:storeId/files/:guuid` | DELETE | Soft-delete → trash | write-gated |
| `stores/:storeId/files/:guuid/restore` | POST | Restore from trash | write-gated |

Client wiring already built: `libs-common/api-manager/src/lib/files` (endpoints + `useStageFileMutation`
via multipart `uploadMutationOptions`, `useCommitFilesMutation`, `useRecordFilesQuery`, cancel/delete/
restore), and an online-only `AttachmentField` (`apps/mobile/src/features/attachments`).

## A6. The gap: online binaries vs offline records

Product create is **offline** (Lane 1); the file pipeline is **online** (Lane 2). At Rev 1–2 **nothing
bridged them** — naively dropping the online `AttachmentField` into the offline `CreateProductScreen`
failed: staging needs connectivity, commit needs connectivity, and "save" doesn't await a server record.
**Rev 3 — that bridge is now built**, exactly as Part C specifies: local persistence of the pending
image (`attachment` table) + a background uploader (`image-uploader.ts`) that runs Lane 2 on Lane 1's
behalf, deferring `stage`/`commit` until connectivity **and** the parent's create mutation have both
landed. The rest of this document (Part C) describes that bridge as-built.

---
---

# PART B — GAP & DIVERGENCE REGISTER

## B1. Where the offline *plan* diverges from what was *built* (errata)

The `product-image-offline-implementation-plan.md` was written against a *presumed* backend. The
backend that shipped is different. Four divergences, each decided in Part C:

1. **Transport: presign/PUT/complete vs stage/commit.** The plan specifies `POST /attachments/presign`
   → client `PUT` to storage → `POST /attachments/complete` (direct-to-S3 presigned PUT). **The built
   backend does backend-mediated multipart** (`stage` → `commit`), and `image-upload-architecture.md`
   Part C **explicitly rejects presigned-PUT for now** ("file sizes here don't justify moving
   validation off the server"). Building presign/complete now would stand up a **second upload
   pipeline** beside the one just built — the exact "two storage pipelines" anti-pattern the upload
   audit flagged (A8). **Decision (C2): keep stage/commit; do not build presign/complete.**
2. **New `attachment` table vs existing `temporary_files`/`files`.** The plan adds an `attachment`
   table with a server-side `status` (`pending_upload`/`uploading`/…). The built server already has
   `temporary_files` (+ `claimed_at`, `expires_at`) and `files` (+ `sha256`, soft-delete). **The
   client-side retry/upload `status` belongs in the client's SQLite, not the server** — the server
   doesn't need a device's retry state. **Decision (C3): reuse the server tables; put `status` only in
   local SQLite.**
3. **Public-CDN reads vs presigned-at-read.** The plan reads images via an unguessable public CDN key
   (§8.2). The built design is **private + presigned GET regenerated per read** (never stored) — more
   secure, and already implemented. **Decision (C7): keep presigned-at-read; no public CDN.**
4. **Delta-syncing the attachment row (with `storage_url`) to other devices vs online fetch.** The
   plan syncs the attachment *row* carrying `storage_url` through `/sync/delta` (§12). But the built
   URL is a **~35-min presigned URL that must not be stored** — a synced URL would be stale on
   arrival. **Decision (C2): other devices get images by an online fetch of the list endpoint
   (fresh presigned URL), cached by `expo-image`; the URL is never delta-synced.**

What the plan got *right* and is preserved: offline capture, local-first display, **separate
transport**, SQLite persistence of the pending item, deferral until the parent exists, idempotency via
`sha256`, orphan guard, "reads never gated," designed placeholder (never a broken-image icon), delete
original after upload / keep local thumb.

## B2. Findings, ranked P0 → P3 (what's missing to make images offline-capable)

**P0 — the feature does not work offline at all without these:**
- **P0-1 No offline capture path.** No `captureProductImage` — no on-device downsize, no persistent
  file write, no local row. The instant-local-display invariant (plan §2.3) is unmet.
- **P0-2 No local `attachment` table.** An app-kill mid-capture/mid-upload loses the image (plan §2.4).
  The uploader has no durable work list.
- **P0-3 Save could block on upload.** The online `AttachmentField` stages synchronously; wiring it
  into create would couple "save" to connectivity — violating "the image never blocks product
  creation" (plan §2.1).

**P1 — correctness/resilience gaps once it's minimally working:**
- **P1-4 No background uploader / transport separation on the client.** Staging must move off the save
  path into an independent, retrying, backoff'd job that runs stage→commit when online (plan §10).
- **P1-5 Defer-until-parent-synced is a client courtesy, not a server rule.** Commit against a
  `record_guuid` whose product hasn't synced yet is *tolerated* by the built commit (`files` is
  polymorphic, no FK). **Superseded by P1-12:** commit must verify the parent, which makes the deferral
  an enforced invariant rather than a hope.
- **P1-6 No orphan guard.** If the product is deleted before upload, the uploader must not upload
  (plan §9-orphan). Not present.
- **P1-7 Cross-device visibility undecided in code.** Reads are online-fetch (B1-4) but nothing fetches
  the record-files query on the product grid/detail yet, and there's no placeholder/badge component.
- **P1-8 Idempotency for a retried *stage*.** The retried *commit* is covered server-side (`claimed_at`
  gate), but there is **no `sha256` dedupe short-circuit at stage** — a retried stage of identical bytes
  creates a second temp object. Add a `(uploaded_by, sha256)` short-circuit, or accept the sweeper
  cleaning the loser. *(Distinct from P1-13, which governs committed rows.)*

**P1 (new — found in the Revision-1 review; each blocks a claim this document makes):**
- **P1-9 `expo-image` disk cache is defeated by presigned-at-read.** `expo-image` caches **keyed by
  URL**. A fresh presigned GET is a *different URL on every read*, so every grid render is a cache miss
  and a full re-download of the bytes. C2-Decision-2 and C10 both assert "disk-cached," which is **false
  as written**. **Fix:** pass a stable `cacheKey` (the `files.guuid`) alongside the rotating `uri` —
  `<Image source={{ uri, cacheKey: file.guuid }} cachePolicy="disk" />`. Without this the whole
  cross-device read strategy silently degrades to re-download-forever.
- **P1-10 The grid is an N+1 over HTTP.** The built read endpoint takes a **single** `record_guuid`
  (`GET /stores/:storeId/files?entity_type&record_guuid`). A 50-product grid on a non-capturing device
  fires **50 requests**, each minting a presigned URL server-side. **Fix:** accept a batched
  `record_guuids` (comma list, capped) and return a `Record<record_guuid, FileDto[]>` map. One request
  per grid render.
- **P1-11 Infinite defer when the parent's mutation is dead.** The uploader's rule is *parent not yet
  synced → reschedule +5 s, not an error.* But an offline-first mutation can **permanently fail**
  (duplicate SKU, server validation rejection, an unresolved conflict). That product never receives a
  server id, so the attachment reschedules **forever**, pinning its local file and never surfacing.
  **Fix:** the orphan guard must inspect the parent's *mutation state* — terminal-failed / dead-lettered
  → mark the attachment `failed` (surface it) or `orphaned` (clean it) — **and** cap total defer
  attempts (`MAX_DEFER_ATTEMPTS`) so no row can loop unbounded.
- **P1-12 `commit` never verifies the parent, and nothing reaps orphan `files` rows.** `files` has no FK
  on `record_guuid`, and the scheduled sweeper reaps **`temporary_files` only**. A buggy or hostile
  client can commit an image against a `record_guuid` that never existed → a permanent phantom `files`
  row, invisible to every read join, consuming storage forever. **Fix (two parts):** (a) `commit`
  resolves `(entity_type, record_guuid, store_fk)` to a **live record** or returns `409
  PARENT_NOT_FOUND`; (b) add an **orphan-`files` audit/reaper** job (carried over from
  `image-upload-architecture.md` C2's orphan-audit item). Because the uploader already defers until
  synced, (a) costs nothing on the happy path.
- **P1-13 (was P2-11) `(record_guuid, sha256)` partial-unique on `files` — MANDATORY, not optional.**
  C6 asserts a double-tap collapses to at most one committed file, but Revision 1 listed the mechanism
  as an optional hardening. A promised guarantee cannot rest on an optional item. **And note the deeper
  point:** the index only collapses **identical bytes**. A double-tap on *camera capture* produces two
  *different* photos with different `sha256` — nothing dedupes them. **Fix (both):** ship the partial-
  unique index `WHERE deleted_at IS NULL` **and** **disable the capture control while a capture is in
  flight**. The index makes duplicates *safe*; the disabled control makes them *not happen*.
- **P1-14 Subscription-lapsed rows require a manual per-photo Retry.** Marking `failed` on
  `SUBSCRIPTION_LAPSED` means 20 pending photos need 20 taps after renewal. **Fix:** a distinct
  `blocked` status, bulk-requeued to `pending_upload` on subscription reactivation (the
  `subscription_version` bump is the trigger).

**P2 — hardening:**
- **P2-9 No server thumbnail.** Client downsizes at capture and renders its local thumb; a server-side
  ~300px thumbnail (for other devices) is deferred.
- **P2-10 Storage management.** No cap/LRU eviction of local thumbs; no pending-count banner.
- **P2-15 Verify `stage` writes the object OUTSIDE the DB transaction, with an S3 timeout.** A2/A3 do
  not state the transaction boundary. This is precisely the legacy system's `P1-6`
  (`image-upload-architecture.md`): an S3 write inside `@Transactional` with no timeout. Latent today;
  a **retrying background uploader on a flaky mobile link** is exactly what converts it into
  connection-pool exhaustion. Confirm and, if needed, reorder to `insert → (outside tx) put → mark`.

**P3 — nits:** no `InteractionManager` deferral of capture work; HEIC handling relies on the picker;
no "N photos waiting" banner; reinstall/new-device loses `pending_upload` rows and their local files
(accepted — those bytes never reached the server; state it, don't fix it).

---
---

# PART C — TARGET ARCHITECTURE (TO-BE)

## C1. The decision, in one paragraph

**Offline capture, local-first display, deferred background upload — running over the EXISTING
two-phase multipart transport (`stage → commit`), not a new presign/complete pipeline.** The image is
captured and downsized on-device, written to app-owned storage, and recorded in a **local SQLite
`attachment` table** the instant it's taken — Save never waits. An **independent background uploader**
(separate from the JSON mutation queue) drains pending attachments when online: it checks the orphan
guard (including a **dead parent-mutation** check, with a bounded defer budget), waits for the parent
product to have synced, **stages** the bytes via the built multipart endpoint, **commits** them to the
product's `record_guuid` — where the **server verifies the parent record actually exists** — then
deletes the local original and keeps the thumbnail. Other devices see the image by an **online, batched
fetch of the list endpoint** (fresh presigned URLs), rendered through `expo-image` with a **stable
`cacheKey` (the file `guuid`)** so the rotating URL doesn't defeat the disk cache; the URL is never
delta-synced. We **do not** build presigned-PUT, a second `attachment` pipeline, a public CDN, or full
offline binary sync — each is deferred behind a named trigger. This is an offline capture/queue layer
**on top of** the pipeline that already exists, not a new pipeline.

## C2. Decision analysis (the critic/decision work)

### Decision 1 — the upload transport

**Approaches:**
- **A. Backend-mediated multipart, deferred (CHOSEN).** Background uploader calls the built `stage`
  (multipart POST through the backend) then `commit`. Reuses the shipped pipeline.
- **B. Presigned PUT (presign → client PUT to storage → complete).** The offline plan's design; a new
  pipeline beside A.
- **C. Full offline binary sync.** Blobs ride a binary-aware sync channel with conflict resolution.
- **D. Online-only (no offline capture).** Rejected up front — breaks the core promise at catalogue
  setup, the exact moment users are offline.

**Head-to-head (weighting for THIS app: single-pipeline simplicity ≫ backend-bandwidth savings,
because product photos downsize to 100–300 KB and there is exactly one shipped pipeline to protect):**

| Approach | Reuses built pipeline | Offline capture | Backend hot-path cost | Second-pipeline risk | Verdict |
|---|---|---|---|---|---|
| **A. multipart deferred** | **Yes** | Yes (queue) | Higher (bytes transit backend) | **None** | **Chosen** |
| B. presigned PUT | No (new endpoints) | Yes | Lower | **High** (two pipelines) | Rejected *now* |
| C. full binary sync | No | Yes (even device→device offline) | — | Very high | Over-engineered |
| D. online-only | Yes | **No** | Higher | None | Rejected (breaks promise) |

**Why A beats each here.** Over **B**: B's only real win is offloading bytes from the backend, which
`image-upload-architecture.md` Part C already deferred until "backend bandwidth is a measured problem"
— at 100–300 KB it isn't, and B costs a *second* validation/commit pipeline (the audit's headline
anti-pattern) plus a new idempotency surface. Over **C**: C solves "Device B needs Device A's photo
while both are offline" — a vanishingly rare case whose failure is a late thumbnail, not a lost sale;
enormous machinery for nil benefit. Over **D**: D fails the founding requirement. **A reuses the one
pipeline we built and hardens, and the deferral is a client concern the client already models (Lane
1).** The background uploader is transport-agnostic (`FileSystem.uploadAsync` can multipart-POST as
easily as PUT), so choosing A costs the client nothing.

### Decision 2 — cross-device image visibility

**Approaches:** (a) delta-sync the attachment row carrying `storage_url`; (b) **online fetch of the
list endpoint per record, fresh presigned URL, `expo-image` disk-cached (CHOSEN)**; (c) delta-sync the
`storage_key` and have each client mint its own signed URL.

**Decision: (b).** (a) is *incorrect* against the built design — the URL is a ~35-min presigned token
that must never be stored; a synced URL is stale on arrival (B1-4). (c) requires client-side signing
credentials — a security regression. (b) matches presigned-at-read exactly: when a product detail/grid
renders on another device, it fetches the record-files list (online), gets fresh URLs, and `expo-image`
caches the bytes on disk. Viewing another device's photo inherently needs connectivity anyway (the
bytes live in object storage), so "online fetch" gives up nothing real. The **local capturing device**
still renders instantly from its local thumb, online or not.

**Two corrections that (b) requires to actually work** (Revision-1 review; both are load-bearing, not
polish):

1. **Stable `cacheKey`, or there is no cache (P1-9).** `expo-image` keys its disk cache **by URL**. A
   fresh presigned GET is a different URL on every read, so the cache never hits and the grid
   re-downloads every image on every render — the opposite of the intent. The URL rotates; the *file*
   does not. Therefore key the cache on the stable identity:

   ```tsx
   <Image
     source={{ uri: file.preview_url, cacheKey: file.guuid }}   // guuid is stable; uri rotates
     cachePolicy="disk"
     transition={0}
   />
   ```

2. **Batch the read, or the grid is an N+1 (P1-10).** The built endpoint takes one `record_guuid`. A
   50-product grid ⇒ 50 requests, 50 presign operations. Extend the endpoint to accept `record_guuids`
   (comma-separated, capped at e.g. 100) and return a `Record<record_guuid, FileDto[]>`. One request per
   grid render. This is a server change, small, and it belongs in the offline build order because it is
   the offline design that creates the fan-out.

With (1) and (2), "online fetch + disk cache" behaves as claimed: **one** request per grid, bytes cached
across renders and across URL rotations, and offline the device falls through to its local thumb or the
designed placeholder.

## C3. Target data model & authority

**Server — reuse the tables, add three guarantees.** `temporary_files` + `files` + `files_config` as
built cover staging, commit, limits, isolation, and soft-delete. **No new tables.** But three server
changes are **required** (not optional) for the offline design to be safe — two of them because
deferral moves the commit far away in time from the capture:

- **✅ BUILT (was REQUIRED) — `commit` verifies the parent record (P1-12a).** Resolve `(entity_type,
  record_guuid, store_fk)` to a **live, non-deleted** record before claiming any temp. If absent → **`409
  file_parent_not_found`**. Implemented in `files/record-existence.service.ts` (`exists()`) — the resolver
  registry (`RECORD_TABLES`) currently holds **`Product` only**; an unregistered entity is fail-closed
  (`ParentVerificationUnavailableError`, 500). The client maps this 409 to **`deferOrOrphan`**: it defers
  while the parent's create mutation is still in-flight and orphans only when that create is terminal (not
  a blind "→ orphaned").

  ```ts
  // files.service.ts — commit(), before claimTemp()
  const parent = await this.records.findLive(entityType, recordGuuid, ctx.getStoreId());
  if (!parent) throw new ConflictException({ code: 'PARENT_NOT_FOUND' });
  ```

  This is the **highest-value change in this revision.** `files.record_guuid` has no FK, so today
  nothing prevents a phantom row. With it, three things that were client-side *courtesies* —
  defer-until-synced, the orphan guard, and no-phantom-rows — become **one server-enforced invariant**.
  Cost on the happy path: one indexed lookup (the uploader has already deferred until the parent synced).

- **✅ BUILT (was REQUIRED) — orphan-`files` reaper (P1-12b)** (`files/orphan-files-reaper.service.ts`,
  cron). The temp sweeper reaps **`temporary_files` only**.
  Add a scheduled audit that finds committed `files` rows whose `(entity_type_fk, record_guuid)` no
  longer resolves to a live record, and soft-deletes them + their objects past a grace window. Carried
  over from `image-upload-architecture.md` C2's orphan-audit item. *(With the commit check above this
  should find nothing — which is exactly why it is worth running: it is the detector that proves the
  invariant holds.)*

- **✅ BUILT (was REQUIRED) — `(record_guuid, sha256)` partial-unique on `files` (P1-13)**
  (`uk_files_record_sha`, migration `drizzle/0032_files_record_sha_dedupe.sql`). Was "optional" in
  Revision 1 while C6 simultaneously promised that a double-tap yields at most one committed file. A
  guarantee cannot depend on an optional item. Shipped as:

  ```sql
  CREATE UNIQUE INDEX uk_files_record_sha
    ON files (entity_type_fk, record_guuid, sha256)
    WHERE deleted_at IS NULL AND sha256 IS NOT NULL;
  ```

  **This only collapses identical bytes.** Two *different* photos from a double-tapped camera have
  different hashes and will both commit. The complete fix is this index **plus** locking the capture
  control while a capture is in flight (C5). Index = duplicates are *safe*; lock = duplicates *don't
  happen*.

- **OPTIONAL — dedupe at stage (P1-8).** Short-circuit an identical re-`stage` by `(uploaded_by,
  sha256)` (return the existing temp) so a retried stage doesn't orphan a second temp object. Cheap; or
  accept the sweeper cleaning the loser. Genuinely optional: the loser is a temp, and the sweeper exists.

- **PARTIAL (was VERIFY) — the `stage` object write sits OUTSIDE the DB transaction (P2-15).** Confirmed
  built: `stageUpload` does `putOrFail` → `insertTemp` with no surrounding tx (a failed insert cleans the
  object); commit copies objects outside the tx too. **But there is no per-S3-call timeout** — only the
  app-wide 30s request timeout; a tighter per-call `requestHandler` timeout remains a follow-up
  (`s3-storage.provider.ts`).

Authority stays as built: `files` is the source of truth; object storage is dumb; images are joined at
read time by `(entity_type_fk, record_guuid, store_fk)`; URLs are presigned per read, never stored.

**Client — the missing piece: local SQLite `attachment` table.** The plan's local schema, with column
names reconciled to the built server (`record_guuid`, `store_fk`, `kind`) and to *this* transport
(a `temp_guuid` staged handle instead of a presign key):

```sql
CREATE TABLE attachment (
  guuid              TEXT PRIMARY KEY,   -- client-generated attachment id
  store_fk           TEXT NOT NULL,
  entity_type        TEXT NOT NULL,      -- 'Product'
  record_guuid       TEXT NOT NULL,      -- parent product's client guuid
  kind               TEXT NOT NULL,      -- 'image'
  status             TEXT NOT NULL,      -- pending_upload|staging|staged|committing|committed
                                         -- |failed|blocked|orphaned
  local_path         TEXT,              -- file:// original (deleted after commit)
  local_thumb_path   TEXT,              -- retained thumbnail (the offline read cache)
  file_guuid         TEXT,              -- server `files.guuid` after commit — the stable expo-image cacheKey
  temp_guuid         TEXT,              -- server temp handle returned by STAGE (before commit)
  mime_type          TEXT,
  size_bytes         INTEGER,
  sha256             TEXT,              -- dedupe + integrity
  attempt_count      INTEGER NOT NULL DEFAULT 0,   -- upload attempts (backoff)
  defer_count        INTEGER NOT NULL DEFAULT 0,   -- parent-not-synced deferrals (BOUNDED — P1-11)
  next_attempt_at    INTEGER,           -- epoch ms, backoff
  last_error         TEXT,
  last_error_code    TEXT,              -- e.g. SUBSCRIPTION_LAPSED → drives bulk requeue (P1-14)
  created_by         TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  deleted_at         INTEGER
);
CREATE INDEX idx_att_pending ON attachment (status, next_attempt_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_att_parent  ON attachment (record_guuid)          WHERE deleted_at IS NULL;
```

`attempt_count`/`defer_count`/`next_attempt_at`/`last_error`/`temp_guuid` are the uploader's **durable**
state — they survive an app kill, which is why they live in SQLite, not memory. `defer_count` is new and
load-bearing: it bounds the parent-not-synced wait so a dead parent mutation cannot loop forever
(P1-11). `file_guuid` is stored after commit because it is the **stable `cacheKey`** the image component
needs while the presigned `uri` rotates (P1-9).

This local table is **not** synced through `/sync/delta` (it's device-local upload bookkeeping); the
*server* `files` row is the shared truth, fetched online (C2-Decision-2). Consequence, accepted: a
reinstall or a new device loses `pending_upload` rows and their local files — those bytes never reached
the server, and there is nothing to recover.

## C4. The attachment state machine (client-owned)

```
   capture
      │
      ▼
 pending_upload ──uploader picks up──▶ staging ──stage ok──▶ staged
      ▲   ▲                               │                    │
      │   │ backoff elapsed               │ transient fail     │ commit
      │   └───────────────────────────────┘                    ▼
      │                                                     committing ──ok──▶ committed
      │ subscription reactivated                            │              (delete original,
      │ (bulk requeue)                                      │ transient     keep thumb,
      │                                                     ▼               store file_guuid)
   blocked ◀── subscription_* (402/403) ──────────────────┐ │
                                                          │ │
   permanent fail (4xx / max attempts) ───────────────────┴─┴──▶ failed (Retry affordance)

   ANY state ──▶ orphaned   when:
                   • parent product soft-deleted locally, OR
                   • parent's create-mutation is TERMINAL-FAILED / dead-lettered  (P1-11), OR
                   • server returns 409 PARENT_NOT_FOUND on commit               (P1-12)
                 ⇒ local original + thumb deleted, row soft-deleted, no user message
```

Legal transitions only. `staging`/`committing → pending_upload` on transient failure (with backoff).
**`status` governs the upload lifecycle; `deleted_at` governs existence** — never express deletion via
`status`.

**Three additions in Revision 2:**
- **`blocked`** (P1-14) — distinct from `failed`. Set **only** on a subscription code
  (`code.startsWith('subscription')`), **NOT** on a permission 403 — a permission denial falls through to
  `failed` (this is what the code does; see D5). Does **not** spin, and does **not** require a per-photo
  manual retry: on subscription reactivation (the `subscription_version` bump) all `blocked` rows are
  **bulk-requeued** to `pending_upload`.
- **`orphaned` now has three triggers**, not one. The dead parent-mutation trigger (P1-11) is the one
  Revision 1 missed: in an offline-first app a create-mutation can permanently fail, and its attachment
  must not wait for a product that will never exist.
- **Bounded deferral.** `pending_upload → pending_upload` (parent not yet synced) increments
  `defer_count`. On `defer_count > MAX_DEFER_ATTEMPTS` (≈ 60, i.e. ~5 min of 5 s retries) the uploader
  re-checks the parent's mutation state and either keeps waiting (mutation still queued/in-flight) or
  transitions to `orphaned`/`failed`. **No path loops unbounded.**

Mapping to the built transport: `staging`=multipart `POST /files/temp` in flight; `staged`=have a
`temp_guuid` (server holds the temp, TTL running); `committing`=`POST /files/commit` in flight;
`committed`=`files` row exists server-side (and `file_guuid` is stored locally as the image `cacheKey`).

## C5. The confirmed offline flow, step by step

**Capture (all local, zero network — Save never waits):**
0. **Lock the capture control** for the duration of the capture (`disabled` while in flight). This is
   half of the double-tap fix (P1-13); the `(record_guuid, sha256)` index is the other half, and it
   only covers *identical* bytes — two different photos from a double-tap would otherwise both commit.
1. Pick/take photo → **downsize to ~1200px @ q0.8** and make a **~300px thumb** on-device
   (`expo-image-manipulator`), both written under `documentDirectory/attachments/` (not cache).
2. Hash the file → `sha256`. Insert an `attachment` row: `status='pending_upload'`,
   `record_guuid = draftProductGuuid`, `temp_guuid = NULL`, `defer_count = 0`. Render the local thumb
   **immediately**.
3. Unlock the control. `ImageUploader.wake()` (no-op offline).

**Save the product (Lane 1, unchanged):** `enqueueCreateProduct` writes the product row + mutation.
The attachment already points at the product `guuid`. **Nothing about the image is awaited.**

**Background uploader (independent of the mutation queue):** a **durable *asynchronous* uploader** — it
runs while the app is alive (wake / online-regained / foreground / after-queue-drain / backoff timer),
not an OS background task that progresses after the app is terminated. Durability comes from the SQLite
`attachment` work list: an app-kill loses no state and the uploader resumes on relaunch (see the
app-killed scenario). *(True background-while-closed uploading would need an Expo background task — not
built, and not required for the POS flow.)* On each run it drains
`status=pending_upload AND next_attempt_at<=now`,
`MAX_CONCURRENT=2`:

1. **Orphan guard (three checks, in order — P1-11/P1-12):**
   a. Parent product missing or soft-deleted locally → `markOrphaned` (delete local files), stop.
   b. **Parent's create-mutation is terminal-failed / dead-lettered** → `markOrphaned` (or `failed` if
      the user should be told) and stop. *A permanently-rejected product (duplicate SKU, validation
      error, unresolved conflict) will never get a server id; its image must not wait forever.*
   c. `defer_count > MAX_DEFER_ATTEMPTS` → re-evaluate (b); if the mutation is still legitimately
      in-flight, keep waiting with a longer interval; otherwise `orphaned`/`failed`. **No unbounded loop.**
2. **Defer-until-synced** — product not yet synced → `defer_count++`, reschedule +5 s (**not** an
   error). The server now *also* enforces this via `PARENT_NOT_FOUND` (P1-12a), so deferral is a
   politeness that avoids a guaranteed-losing request, not the only line of defence.
3. `status='staging'` → **stage** the bytes: `POST /stores/:storeId/files/temp` via
   `FileSystem.uploadAsync` (multipart, `entity_type='Product'`, `kind='image'`), **with a request
   timeout**. Store the returned `temp_guuid`; `status='staged'`.
4. `status='committing'` → **commit**: `POST /stores/:storeId/files/commit`
   `{ entity_type:'Product', kind:'image', record_guuid, file_guuids:[temp_guuid] }`. The server
   **verifies the parent exists** (P1-12a) and its `claimed_at` gate makes this **at-most-once** — one
   staged temp can't become two `files` rows. **Caveat (backend D4):** if the server commits but the
   *response is lost*, the retry finds the temp already deleted and gets `temp_file_not_found` (marked
   `failed` here) — commit is not yet retry-*idempotent*; a client idempotency key is the fix.
5. On success → `status='committed'`, **store `file_guuid` from the response** (the stable image
   `cacheKey`), delete `local_path` (**keep `local_thumb_path`** — it is this device's offline read
   cache).
6. On failure, classify (`handleFailure` — wire codes are matched **lowercase**):
   - **`file_parent_not_found`** → **`deferOrOrphan`**: defer while the parent's create mutation is still
     in-flight; `orphaned` (delete local files, no user message) only once that create is terminal.
   - **`temp_file_expired`** → drop `temp_guuid`, return to `pending_upload` and **re-stage** from the
     retained local original. *(This is why the original is deleted only after commit.)*
   - **`startsWith('subscription')`** → **`blocked`** (P1-14), not `failed`. Do not spin. Bulk-requeued on
     subscription reactivation. **A permission 403 is NOT blocked** — it has no `subscription` prefix, so
     it falls through to `failed` below (see D5). *(Now reachable: backend D2 enforces the parent entity's
     `edit` grant on every write, so a read-only member's stage/commit gets `permission_denied` → `failed`.)*
   - **transient** (`isOffline`, status `0`/`408`/`429`/`≥500`) and `attempt_count < MAX_UPLOAD_ATTEMPTS`
     → `pending_upload` + exponential backoff + jitter (cap ~5 min, `MAX_UPLOAD_ATTEMPTS = 8`).
   - **other permanent 4xx / max attempts** → `failed` with a Retry affordance.

**Display resolution order (always):**

```
1. local_thumb_path              → render (instant, offline, before AND after commit)
2. remote (batched online fetch) → render via expo-image with  cacheKey = file_guuid   ← P1-9
3. designed placeholder          → product initials on a tokenized bg. NEVER a broken-image icon.
```

- **Grid reads are batched** (`record_guuids[]`, one request per grid render — P1-10), never one query
  per product.
- **`cacheKey` is mandatory** wherever a presigned `uri` is rendered; the URL rotates every read, the
  `guuid` does not. Without it the disk cache never hits.
- **Accepted tradeoff (state it, don't fix it):** after commit the full-resolution original is deleted
  and only the ~300 px thumb is retained, so an **offline product-detail view on the capturing device
  shows an upscaled thumbnail**, not the full image. Correct for a POS; the full image returns the
  moment the device is online. The alternative — retaining every original forever — is an unbounded
  storage tail on a device.

Corner badge: `pending_upload`/`staging`/`committing` → cloud-arrow (ambient, **no spinner over the
image**); `blocked` → subtle lock/plan badge; `failed` → warning, tap = "Retry upload"; `committed` →
none. **Background success is silent** — the badge disappearing is the feedback; a toast would be noise.

**Delete:** before commit → soft-delete the local row + delete local files (cancel `temp_guuid` via
`DELETE /files/temp/:guuid` if staged); after commit → `DELETE /files/:guuid` (server soft-delete →
trash) and drop the local thumb.

## C6. Behaviour in every real-time scenario

| Scenario | Behaviour (grounded in a built primitive) |
|---|---|
| **Airplane capture** | File + thumb written, row `pending_upload`, thumb visible instantly. Zero network. Save doesn't wait. |
| **Restore network** | `wake()` → stage → commit; badge clears. Product row unaffected (separate transport). |
| **App killed mid-upload** | `status` (`staging`/`committing`) persisted in SQLite. On relaunch, stale in-flight rows past a TTL revert to `pending_upload`; the server `claimed_at` gate + sweeper prevent a double or an orphan. |
| **Double-tap capture (same photo)** | The capture control is **locked during capture** (C5-0), so a second row is not created. If one slips through (two rapid picks), identical bytes → same `sha256` → the **mandatory** `(record_guuid, sha256)` partial-unique (C3/P1-13) collapses them: one committed `files` row. |
| **Double-tap capture (two *different* photos)** | Different `sha256` — **the index does not dedupe them.** The capture-control lock is the only thing that prevents this, which is why it is mandatory and not polish. Without it: two committed images on one product. |
| **Parent deleted before upload** | Orphan guard → `markOrphaned`, local files deleted, **no stage, no commit**. No server orphan. |
| **Parent not yet synced** | Uploader defers +5 s, `defer_count++` (not an error). Product syncs → next drain stages+commits. Server also rejects a premature commit with `PARENT_NOT_FOUND`, so this is defence in depth. |
| **Parent's create-mutation permanently fails** (duplicate SKU, validation reject, dead-lettered) | **P1-11.** Orphan guard step 1b sees the terminal mutation state → `orphaned` (local files deleted) or `failed` if the user should be told. **The attachment never loops.** `MAX_DEFER_ATTEMPTS` is the backstop. |
| **Client commits against a `record_guuid` that never existed** (bug / hostile client) | **P1-12a.** `commit` resolves `(entity_type, record_guuid, store_fk)` to a live record → absent → `409 PARENT_NOT_FOUND`. **No phantom `files` row is ever created.** The orphan-`files` reaper (P1-12b) is the detector that proves this holds. |
| **PUT/stage ok, commit fails** | Retry commit; the temp still exists (TTL); `claimed_at` makes the retried commit exactly-once. Bytes not re-sent. |
| **Staged temp expired before commit** | Commit returns `TEMP_FILE_EXPIRED` → re-stage from the retained local original. |
| **Concurrent double-commit (two devices / retry)** | `claimed_at IS NULL` gate → exactly one wins, one `files` row. **But** a lost-response retry (server committed, client didn't hear) gets `temp_file_not_found`, not the committed file — not yet retry-idempotent (backend D4). |
| **Subscription lapsed while pending** | `stage`/`commit` are writes → gated → `SUBSCRIPTION_LAPSED` → mark **`blocked`** (don't spin). **Viewing existing images still works** (reads exempt GET). |
| **Subscription reactivated with 20 blocked photos** | **P1-14.** The `subscription_version` bump triggers a **bulk requeue** of all `blocked` rows → `pending_upload`. The user taps nothing. (Revision 1 required 20 manual retries.) |
| **Permission revoked (Product:edit) before upload** | Write route 403 → `failed` with a clear message. (Point-in-time RBAC is for POS money, not a thumbnail.) |
| **Cross-tenant** | Temps are owner-scoped; commit + reads are store-scoped by `TenantGuard`+`store_fk`. Another store can't stage-adopt or view. |
| **Two devices, different photos, same product, offline** | Both stage+commit; both `files` rows exist; the product's displayed image is last-committed. No conflict UX (accepted). |
| **Cold start, new device** | No local originals; the product grid issues **one batched** record-files request (`record_guuids[]`, P1-10) → fresh presigned URLs → `expo-image` disk-caches **keyed by `file_guuid`** (P1-9). Lazy-loaded on scroll, never bulk-downloaded. |
| **Same grid re-rendered / re-opened (online)** | Presigned URLs rotate, but `cacheKey = file_guuid` is stable → **disk cache hits**, zero re-download. Without `cacheKey` this is a full re-download every render. |
| **Grid of 50 products on a non-capturing device** | **One** HTTP request (batched), 50 presigned URLs. Without batching: 50 requests, 50 presign operations, per render. |
| **Reinstall / new device with pending uploads** | Local `attachment` rows and files are gone; those bytes never reached the server. **Accepted, unrecoverable, by design.** |
| **Abandoned stage (never committed)** | Server sweeper reaps the temp + object past `expires_at`. Local row: user removed → soft-deleted; else retried. |
| **Device storage full at capture** | Graceful "Not enough space"; downsizing makes it rare; no partial row. |

## C7. Security & isolation model (reuse the built guards)

- Stage/commit/delete run behind `Throttle → MobileJwt → Tenant(param.storeId) → Subscription(write)`;
  reads (`GET`) are **exempt** from the write-gate (built). `Product:edit` permission enforcement is a
  follow-up on the files controller (files are polymorphic; parent-entity permission isn't wired yet —
  see `image-upload-architecture.md` C-open-items).
- **`store_fk` from the resolved tenant context, never the request body** (built — the service reads
  `ctx.getStoreId()`).
- **Client never chooses the storage key** — the server builds `tmp/{userId}/…` and
  `{storeId}/{entityCode}/{recordGuuid}/{uuid}/{name}` (built).
- **Content sniffing + extension allow-list + size caps enforced server-side at ingestion**; SVG/markup
  rejected; `image/svg+xml` never rendered inline (built — `file-validation.service.ts`,
  `files-raw.controller.ts`).
- **Private + presigned-at-read** (~35 min), never a stored/public URL (built).
- **Rate-limit stage** (mints an upload) — the app's throttler already fronts routes.
- **NEW — `commit` verifies the parent (P1-12a).** Beyond integrity, this is an *isolation* control: it
  forecloses a client committing a file against an arbitrary `record_guuid` (including one belonging to
  another store — the tenant check on `store_fk` and the parent lookup now agree). `files.record_guuid`
  has no FK, so this check is the only thing standing between a hostile client and a phantom row.
- **NEW — orphan-`files` reaper (P1-12b).** Detects (and cleans) any committed row whose parent no
  longer resolves. With the commit check in place it should find nothing; running it is how you *know*
  the invariant holds rather than assuming it.
- **VERIFY — `stage`'s object write sits outside the DB transaction and has an S3 timeout (P2-15).**

## C8. Build order & what's already done

**Already built (Part A):** the entire online pipeline (stage/commit/read/delete + `claimed_at` gate +
sweeper + content-sniff + presigned-at-read), the api-manager `files` domain (incl. multipart
`uploadMutationOptions`), and an online `AttachmentField`. Backend integration tests green (tenant
isolation, commit atomicity, content-sniff, sweeper).

**Offline build — Rev 3: steps 0–7 are SHIPPED** (see the header build-status table for file refs).
**Remaining:** (a) a product-grid/list screen must *consume* the batched read — pass `remoteFile` into
`RecordImage` — to light up cross-device grid display (the endpoint, api-manager hook, and
`findByRecordGuuids` all exist but no screen calls them yet); (b) a per-S3-call timeout (P2-15); (c)
optional stage dedupe (P1-8) and storage management (steps 8–9). The original build order, annotated:

**Step 0 — PREREQUISITE, verify before writing any code (was C11 open-question #1; it is
build-blocking, not an open question — I2).**
Confirm in the **target environment** that `entity_types` has `Product` with
`supports_attachments = true`, **and** that a `files_config` rule resolves for `(Product, image)`. **As
built, this is an entity-wide rule** (`file_kind = null`) seeded for every attachment-supporting entity —
`findRule` falls back to it when no kind-specific row exists. The validation path throws on a missing
config lookup — without a resolvable rule the first `stage` returns a 500. **Caveat (backend D3):** the
null-kind rule allows `pdf`, so `kind='image'` currently accepts a PDF; a kind-specific
`(Product, image)` rule (images only) is the recommended hardening.

1. **Deps:** `expo-image-manipulator`, `expo-file-system`, `expo-crypto` (picker + `expo-image` already
   in).
2. **Local `attachment` table** (C3, incl. `file_guuid`, `defer_count`, `last_error_code`) + a
   Drizzle-SQLite migration + a repository.
3. **Server guarantees (REQUIRED — do these before the uploader exists, so it is never built against a
   permissive server):**
   a. `commit` verifies the parent → `409 PARENT_NOT_FOUND` (**P1-12a**).
   b. `(entity_type_fk, record_guuid, sha256)` partial-unique on `files` (**P1-13**).
   c. Batched read: `GET /stores/:storeId/files?entity_type&record_guuids=a,b,c` → map (**P1-10**).
   d. Verify `stage` writes the object outside the DB tx, with an S3 timeout (**P2-15**).
4. **Capture flow** — **lock the capture control** → pick/take → downsize + thumb → persist files →
   insert row → `wake()`. Wire the product form to hold the product `guuid`; **Save never awaits**.
5. **Display** — resolution order (local thumb → batched online fetch → placeholder); **`cacheKey =
   file_guuid`** on every `expo-image` with a presigned `uri` (**P1-9**); upload-state badge
   (incl. `blocked`); a `useProductImage(productGuuid)` reactive SQLite read; the grid uses the **batched**
   record-files query.
6. **Background uploader** — drain loop, **three-part orphan guard** (deleted parent / dead parent
   mutation / defer budget — **P1-11**), defer-until-synced, stage→commit over the built endpoints
   (reusing the stage/commit mutation logic in a non-React service via the `APIData` instances
   directly), backoff+jitter, error classification incl. `PARENT_NOT_FOUND` → `orphaned`,
   `TEMP_FILE_EXPIRED` → re-stage, `SUBSCRIPTION_LAPSED` → `blocked`; `markCommitted` stores
   `file_guuid` and deletes the original. Triggers: post-capture, online-regained, foreground,
   post-queue-drain, backoff timer, **subscription-reactivated (bulk requeue of `blocked` — P1-14)**.
7. **Orphan-`files` reaper** (**P1-12b**) — scheduled audit + soft-delete past a grace window.
8. **Stage dedupe (P1-8, optional)** — `(uploaded_by, sha256)` short-circuit.
9. **Storage management** — LRU-evict committed thumbs, "N photos waiting" banner.
10. **Tests** — the C10 critical list + backend real-DB idempotency/tenancy/parent-check.

**Ship 0 → 3 → 4 → 5 → 6.** Step 3 (server guarantees) must land **before** step 6, so the uploader is
never written against a server that tolerates phantom rows. Steps 7–10 are hardening.

## C9. What to defer, with the trigger that flips it

- **Presigned-PUT (plan's presign/complete)** — until backend upload bandwidth is a *measured* hot-path
  cost (it isn't at 100–300 KB). Flipping it means adding endpoints, not changing the client uploader
  (transport-agnostic).
- **Server-side thumbnail worker** — until the local-thumb-only story hurts cross-device grids; the
  client thumb covers the capturing device today.
- **Full offline binary sync (device↔device offline)** — until a confirmed requirement; the failure
  today is a late thumbnail, not a lost sale.
- **Public CDN / signed-URL caching** — until a screen renders hundreds of images per request (signing
  is local, not a bottleneck at this scale).
- **Delta-syncing attachment rows** — never for the *URL* (presigned expiry); only reconsider if a
  fully-offline cross-device thumbnail becomes a requirement (then sync `storage_key`, sign locally).
- **Account-wide storage quota** — until overage becomes a hard capacity constraint (per-record limits
  via `files_config` hold for now).

## C10. Acceptance criteria (traceable)

Production-ready when these pass (mirrors the plan's DoD, retargeted to the built transport):
**Prerequisite (Step 0):**
- [ ] `entity_types.Product.supports_attachments = true` **and** a `files_config` rule **resolves** for
      `(Product, image)` — an entity-wide (`file_kind = null`) rule suffices; a kind-specific images-only
      rule is preferred (backend D3). *(Without a resolvable rule the first `stage` 500s.)*

**Core (Revision 1, retained):**
- [ ] Product creation **never** waits on the image (airplane-mode test).
- [ ] Image visible locally the instant it's captured, offline.
- [ ] Uploads run on a **separate transport** from the mutation queue (a stalled upload never delays a
      sale syncing).
- [ ] `attachment` row persisted in SQLite; app-kill mid-upload resumes and commits with **at-most-once
      row creation** (the `claimed_at` gate + `uk_files_record_sha`). *(Note D4: a kill after the commit tx
      but before `markCommitted` re-commits and hits `temp_file_not_found` → surfaces as `failed` though it
      committed; a commit idempotency key closes this.)*
- [ ] Orphan guard: parent deleted → no stage/commit, local files cleaned, no server orphan.
- [ ] Defer (not fail) when the parent product hasn't synced.
- [ ] Storage key server-generated; mime/size/content-sniff enforced server-side; SVG never inline.
- [ ] `store_fk` from tenant context; cross-tenant stage-adopt and read denied.
- [ ] Stage/commit/delete subscription-write-gated; **viewing images never gated** (built).
- [ ] Other devices show a **designed placeholder** until an online fetch returns a fresh presigned URL.
- [ ] Background success **silent**; permanent failure → one non-blocking toast + Retry.
- [ ] Downsized at capture; original deleted after commit; local thumbnail retained.
- [ ] Grid = virtualized list; no bulk download on cold start.
- [ ] Placeholder/badges from design tokens; dark mode works.

**Revision-2 gates (each maps to a defect; the feature is NOT done without these):**
- [ ] **D1/P1-9 — cache actually caches.** Render a grid twice online, capture network traffic: the
      second render issues **zero** image byte requests. (Fails without `cacheKey = file_guuid`; the
      presigned `uri` differs every read.)
- [ ] **D2/P1-10 — grid is one request.** A 50-product grid on a non-capturing device issues **one**
      record-files request, not fifty.
- [ ] **D3/P1-11 — no infinite defer.** Create a product offline whose create-mutation will be
      permanently rejected (duplicate SKU); attach a photo; go online. The product mutation
      dead-letters; the attachment reaches `orphaned`/`failed` and **stops**. `defer_count` never
      exceeds `MAX_DEFER_ATTEMPTS`. No 5-second loop persists.
- [ ] **D4a/P1-12a — commit rejects a phantom parent.** POST `commit` with a `record_guuid` that does
      not exist in this store → **`409 PARENT_NOT_FOUND`**; **no `files` row and no committed object**
      are created. (Test directly against the API, bypassing the client's defer.)
- [ ] **D4b/P1-12b — orphan reaper exists and finds nothing.** With the commit check live, the
      scheduled orphan-`files` audit reports zero orphans on a seeded dataset; force one (direct DB
      insert) and confirm it is detected and soft-deleted past the grace window.
- [ ] **I1/P1-13 — double-tap.** (a) Capture control is disabled while a capture is in flight.
      (b) Two commits of **identical** bytes to one record → exactly one live `files` row (partial-unique
      index). (c) Documented: two *different* photos from a double-tap are prevented by (a), not by (b).
- [ ] **P1-14 — blocked, not failed.** Lapse the subscription with 3 pending photos → all become
      `blocked`, viewing existing images still works, the uploader does **not** spin. Reactivate → all 3
      **auto-requeue** and upload with **zero** user taps.
- [ ] **`TEMP_FILE_EXPIRED` → re-stage.** Let a staged temp expire, then commit → the client re-stages
      from the retained local original and succeeds. (Proves the original is not deleted before commit.)
- [ ] **P2-15 — `stage` object write is outside the DB transaction and has an S3 timeout.** Verified by
      code inspection; a throttled/hung S3 must not hold a DB connection.
- [ ] **Accepted tradeoff documented:** offline product-detail on the capturing device shows the
      upscaled ~300 px thumb (the original is deleted after commit); the full image returns when online.

## C11. Open questions

**Resolved in Revision 2** (no longer open):
- ~~`entity_types` / `files_config` seed for `(Product, image)`~~ → **not an open question; it is
  build-blocking.** Promoted to **C8 Step 0**, verified before any code.
- ~~Stage dedupe: implement or accept?~~ → **Optional (P1-8), accept sweeper cleanup.** The *committed*-
  row guarantee is now carried by the **mandatory** `(record_guuid, sha256)` partial-unique (P1-13) plus
  the capture-control lock, so stage dedupe is a bandwidth nicety, not a correctness requirement.

**Resolved in Revision 3** (closed by the build):
- ~~Local `attachment` table sync exposure~~ → **device-local, confirmed.** Not in `/sync/delta`; no
  consumer reads attachment rows from delta.
- ~~`MAX_DEFER_ATTEMPTS` value~~ → **set to `60`** (~5 min at 5 s) in `image-uploader.ts`; on exceed it
  re-inspects the parent's mutation state rather than hard-failing.
- ~~Dead-letter signal~~ → the mutation queue exposes terminal states **`rejected`/`dead`**;
  `isParentTerminal` reads them and the orphan guard (step 1b) acts on them.

**Still open:**
1. **`user-level` files (`store_fk` nullable)** — avatars/logos aren't store-scoped; keep `store_fk`
   nullable with a separate access path, or make it `NOT NULL` and route avatars elsewhere? (Blocks the
   avatar surface; not product images.)
2. **Cross-device grid display is unwired at the screen layer (D8)** — the batched read endpoint, the
   api-manager hook, `attachment.repository.ts findByRecordGuuids`, and `RecordImage`'s `remoteFile` prop
   all exist, but **no product grid/list screen fetches the batch or passes `remoteFile`** yet. Until a
   screen does, a non-capturing device shows the designed placeholder (never a broken image), but not the
   remote photo. This is the main *functional* gap remaining.
3. **Thumbnail** — is the client-only local thumb acceptable for v1 cross-device grids (remote shows the
   full image until a server thumb exists), or is a server thumb needed at launch? *(With `cacheKey` +
   batching in place, the grid cost is bytes, not requests — which raises the value of a server thumb but
   does not block launch.)*

*(`Product:edit` authorization and the per-S3-call timeout are now closed — see D2/D7 in the review
findings below.)*

**Pre-production review findings (backend-owned; full detail in
[`image-upload-architecture.md`](../backend/image-upload-architecture.md) Part D).** These affect the
end-to-end feature even though the fixes live in the backend:
- **D1 — ✅ FIXED (High) — per-record budget race:** commit now serializes per record via an advisory lock
  and re-checks the budget in-transaction.
- **D2 — ✅ FIXED (High) — per-parent-entity authorization:** every write (stage/commit/delete/restore)
  now requires the parent entity's `edit` grant (`FilesService.assertCanEditEntity`). A read-only member
  can no longer modify attachments; a denial returns `permission_denied` (403) → the uploader marks it
  `failed` (D5).
- **D3 — ✅ FIXED (High) — `kind=image` accepted PDF:** a kind-specific `image` rule (images only) is now
  seeded and preferred by `findRule`. *(Re-run the seed on existing environments.)*
- **D4 — OPEN (Med) — commit not retry-idempotent:** a lost commit response → the retry sees the temp gone
  and marks the image `failed` though it committed. Fix: client idempotency key + return prior result.
- **D6 — ✅ FIXED (Med) — sweeper vs. claim race:** the sweeper now skips freshly-claimed temps (reaps only
  unclaimed rows, or claims older than a grace window).
- **D7 — ✅ FIXED (Med) — per-S3-call timeout/cancellation:** each object-store call now runs under an
  `AbortSignal` timeout with bounded SDK retries.

---

*This is the offline-first architecture of record for product images. It layers offline capture + a
local queue + a background uploader **on top of the already-built two-phase multipart file pipeline** —
deliberately not a second pipeline, not presigned-PUT, not full binary sync. Capture is offline-first;
distribution is online-when-available. **Rev 3: Part C's build order has landed** — the capture flow,
local `attachment` table, background uploader, commit parent-check, orphan reaper, sha256 dedupe, and
batched read are all built (header table). The two things left before the steady state is fully realised
are wiring a product-grid screen to the batched read (cross-device display) and a per-S3-call timeout.*

*Revision 2 changed nothing about the **architecture** — the transport, authority model, and separation
of the two lanes were all correct. It fixed the **read path** (a cache that never cached; a grid that
fanned out N requests) and the **failure paths** (an unbounded defer loop; a commit that trusted the
client about its own parent). Those are the two places this class of design breaks, and neither is
visible on the happy path — which is exactly why they had to be found by stress-testing the scenarios
rather than by reading the flow.*