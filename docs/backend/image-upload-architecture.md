# Image / File Upload — Backend Architecture (As-Built, NestJS)

> **The authoritative architecture document for the file/image upload backend in this repo.** It
> describes the **current NestJS implementation** under `apps/backend/src/files` — a two-phase
> (stage → commit) upload pipeline over an object store (S3-compatible, or an on-disk provider in dev),
> with Postgres/Drizzle as the source of truth.
>
> **Repo & stack.** `ayphen-retail-pos` (Nx monorepo). Backend: NestJS + TypeScript (`apps/backend`),
> Postgres via Drizzle ORM, `@aws-sdk/client-s3` (lazy-loaded). Object storage: Supabase Storage
> (S3-compatible) in the configured environment; an on-disk `LocalStorageProvider` when `STORAGE_BUCKET`
> is unset.
>
> **History.** This feature is a ground-up rebuild of the legacy Spring Boot `com.ayphen.api` file
> pipeline. The legacy analysis (its defects and the decided target) informed this design; that target
> is now built. The **client-side offline capture/upload layer** (local `attachment` table, background
> uploader, display) is a separate concern documented in
> [`docs/mobile/image-offline-architecture.md`](../mobile/image-offline-architecture.md) — this document
> is the **backend** contract that layer rides on.
>
> **How to read this.** Part A is the system as-built (data model, flows, validation, storage, security,
> jobs, contract). Part B shows how the legacy defect classes are structurally closed by this design.
> Part C is what is deliberately deferred / not yet built. Every claim is cited `file:line` under
> `apps/backend/src/`.

---

## Table of contents

- **Part A — Current architecture (as-built)**
  - A1. System context & the two-phase pipeline
  - A2. Data model (`files` / `temporary_files` / `files_config`)
  - A3. Flows — stage → commit → read → delete/restore → cancel
  - A4. Validation & content safety
  - A5. Storage provider abstraction & presigned reads
  - A6. Security & isolation model
  - A7. Scheduled jobs (temp sweeper, orphan reaper)
  - A8. API / contract surface
  - A9. One upload followed end to end
  - A10. Configuration
- **Part B — How the legacy defect classes are closed**
- **Part C — Deferred / not yet built**

---
---

# PART A — CURRENT ARCHITECTURE (AS-BUILT)

## A1. System context & the two-phase pipeline

The feature lets an authenticated store user attach a file (image, PDF, office doc) to a business
record — today, product images. It is **two-phase** so the byte upload is decoupled from linking the
file to a parent record (which lets the offline client capture before the parent exists):

```
┌──────────────┐   ┌────────────────────┐   ┌──────────────────────┐   ┌───────────────────────┐   ┌──────────────┐
│ Pick/capture │ → │ STAGE               │ → │ Object write +       │ → │ COMMIT                │ → │ Read via     │
│ (client)     │   │ POST .../files/temp │   │ temporary_files row  │   │ POST .../files/commit │   │ presigned    │
│              │   │ multipart, VALIDATED │   │ (owner-scoped)       │   │ verify parent → copy  │   │ GET (35 min) │
└──────────────┘   └────────────────────┘   └──────────────────────┘   │ → files row (store)   │   └──────────────┘
                                                                        └───────────────────────┘
```

**Design invariants (enforced in code, not by convention):**
1. **Backend-mediated multipart** — the client always sends bytes through the backend; the backend owns
   every object-store write. Presigned URLs appear only on the **read** side. (No presigned-PUT-from-client.)
2. **Validation at ingestion** — extension, size, and magic-byte content sniff run at **stage** time
   ([`file-validation.service.ts:34`](../../apps/backend/src/files/file-validation.service.ts#L34)), not
   deferred to commit. Record-scoped rules (count, consolidated size) run at commit.
3. **Owner-scoped temps, store-scoped files** — a staged temp is only ever readable/claimable by its
   uploader (`uploaded_by`); a committed file is only ever readable by its store (`store_fk`). **No
   method looks a file up by key/guuid alone** ([`files.repository.ts:13-20`](../../apps/backend/src/files/files.repository.ts#L13)).
4. **The parent must exist to commit** — commit resolves `(entity_type, record_guuid, store_fk)` to a
   live record before writing any `files` row ([`files.service.ts:129-134`](../../apps/backend/src/files/files.service.ts#L129)).

**Actors.** Authenticated store user (stages, commits, reads, deletes); a second store's user (the
isolation adversary); two scheduled jobs (temp sweeper, orphan-files reaper). There is no inbound-email
ingestion in this repo.

---

## A2. Data model

Schema: [`apps/backend/src/db/schema.ts:1005-1095`](../../apps/backend/src/db/schema.ts#L1005). Three tables.

| Table | Role | Key columns | Scoped by | Notes |
|---|---|---|---|---|
| `temporary_files` | Staged, not-yet-linked uploads | `id`, `guuid` (unique), `file_name`, `storage_key`, `size_bytes`, `mime_type`, `sha256`, `uploaded_by` (→`users`), `expires_at`, **`claimed_at`** | **owner** (`uploaded_by`) — **no store column** | Ephemeral, **no soft-delete**; the row's existence *is* the pending state. `claimed_at` is the atomic commit gate. `expires_at` drives the sweeper. Index: `idx_temporary_files_expires_at`. |
| `files` | Permanent, record-linked (source of truth) | `id`, `guuid` (unique), `entity_type_fk` (→`entity_types`), `record_id` (no FK), `record_guuid` (no FK), `store_fk` (→`stores`, **nullable** = user-level), `kind`, `storage_key`, `thumbnail_url`, `mime_type`, `size_bytes`, `sha256`, `original_filename`, `is_private` (default true), `description`, audit cols + `deleted_at`/`deleted_by` | **store** (`store_fk`) | Polymorphic parent pointer `(entity_type_fk, record_guuid)` with **no DB FK** — enforced in app + orphan reaper. Indexes: `idx_files_entity_record`, `idx_files_store`, and the dedupe unique below. |
| `files_config` | Per-`(entity, kind)` validation rules | `entity_type_fk` (→`entity_types`), `file_kind` (nullable = entity-wide), `max_file_size_bytes`, `max_consolidated_size_bytes`, `valid_extensions` (comma list), `max_attachments_allowed`, `is_active` | via `entity_type` FK | Real referential integrity (not polymorphic). Unique `uk_files_config_entity_kind (entity_type_fk, file_kind)`. Drives all validation limits. |

**Dedupe (P1-13, built).** `uk_files_record_sha` — a **partial unique index** on
`(entity_type_fk, record_guuid, sha256) WHERE deleted_at IS NULL AND sha256 IS NOT NULL`
([`schema.ts:1062-1064`](../../apps/backend/src/db/schema.ts#L1062), migration
`drizzle/0032_files_record_sha_dedupe.sql`). The same bytes committed to the same record twice — a
retried commit or a double-tap of the *same* photo — collapse to one live row.

**`files_config` seed (Step 0).** `Product` has `supports_attachments = true`
(`entity-catalogue.ts`), and the seed inserts an **entity-wide** rule (`file_kind = null`) for every
attachment-supporting entity: **10 MB/file, 50 MB consolidated, `jpg,jpeg,png,webp,gif,pdf`, max 10**
(`seed.ts`) — SVG deliberately excluded. Rule lookup (`configRepo.findRule`) resolves against this
null-kind row.

**Data authority.** The `files` row is the source of truth for "this file exists and is linked here."
Object storage is a dumb blob store. Images are **not** denormalised URL columns — they are joined at
read time via `(entity_type_fk, record_guuid, store_fk)`. Presigned URLs are **regenerated per read** and
**never stored** — `FilesMapper` never emits `storage_key`, only a fresh signed URL.

---

## A3. Flows

All under [`files.service.ts`](../../apps/backend/src/files/files.service.ts) unless noted. The service
reads the caller's identity from `RequestContextService` (`requireUserId`/`requireStoreId`, `:407-417`) —
never from the request body.

### A3.1 Stage — `POST /stores/:storeId/files/temp` ([`:71`](../../apps/backend/src/files/files.service.ts#L71))

1. `requireUserId()`; resolve the entity + its `files_config` rule, asserting `supports_attachments`
   (`resolveEntityAndRule`, `:350`).
2. **Validate at ingestion** (`validation.validateAtIngestion`, A4): extension + per-file size +
   magic-byte content sniff.
3. `sha256` of the bytes; build the **server-owned** key `tmp/{userId}/{uuid}/{safeName(originalName)}`
   (`safeName` strips path separators and unsafe chars, `:421`).
4. `putOrFail` the object **outside any DB transaction** (`:81`, `:376`) → wraps failures as
   `StorageUnavailableError` (503).
5. `insertTemp` a `temporary_files` row with `expires_at = now + TEMP_FILE_TTL_HOURS` (24h). If the
   insert throws after the object landed, `safeDelete` the object (best-effort; the sweeper is the backstop).
6. Return `{ guuid, file_name, size_bytes, mime_type, sha256, expires_at, preview_url }` — `preview_url`
   is a fresh presigned GET (35 min) so the client can preview before commit.

### A3.2 Commit — `POST /stores/:storeId/files/commit` ([`:115`](../../apps/backend/src/files/files.service.ts#L115))

Body: `{ entity_type, record_guuid, kind, file_guuids[], record_id?, description? }`.

1. `requireUserId()` + `requireStoreId()`; resolve entity + rule.
2. **Parent verification** — `recordExistence.supports(entity_type)` → `ParentVerificationUnavailableError`
   (500) if the entity has no registered resolver; then `recordExistence.exists(entity_type, record_guuid,
   storeId)` → **`ParentRecordNotFoundError` (409 `file_parent_not_found`)** if there is no live,
   store-owned record ([`record-existence.service.ts:101`](../../apps/backend/src/files/record-existence.service.ts#L101)).
   The resolver registry (`RECORD_TABLES`) currently holds **`Product` only** — fail-closed.
3. `resolveTemps` (`:166`) — batched, **owner-scoped**, order-preserving; a missing guuid →
   `TempFileNotFoundError`, an expired one → `TempFileExpiredError`. No claim yet (validation runs first).
4. `assertRecordBudget` (`:180`) — count + consolidated-size checks applied cumulatively over the batch on
   top of the record's existing `recordStats`.
5. `claimAll` (`:202`) — atomic `UPDATE … SET claimed_at = now WHERE guuid = ? AND uploaded_by = ? AND
   claimed_at IS NULL` per temp ([`files.repository.ts:68`](../../apps/backend/src/files/files.repository.ts#L68)).
   Two concurrent commits of the same upload race here; the loser gets `null` and aborts — one staged file
   can never become two `files` rows.
6. `copyStaged` (`:218`) — copy each staged object to its committed key
   `{storeId}/{entityCode}/{recordGuuid}/{uuid}/{safeName}`, concurrently; on any failure, delete the
   copies that landed and throw `StorageUnavailableError`.
7. `persistFiles` (`:237`) — **one DB transaction**: insert each `files` row and delete its temp row. If
   the tx throws, delete the staged→committed copies (no dangling reference).
8. Best-effort delete of the staged objects; return `FileResponse[]` (each with a fresh presigned URL).
   On any outer failure, `releaseClaims` frees the `claimed_at` gate so the client can retry before TTL.

### A3.3 Read (store-scoped, fresh presigned URL per read)

- **Single record** — `GET /stores/:storeId/files?entity_type&record_guuid` → `listByRecord` (`:279`).
- **Batched grid** — `GET /stores/:storeId/files/by-records?entity_type&record_guuids=a,b,c` →
  `listByRecords` (`:292`): one query for many records, returns a `Record<record_guuid, FileResponse[]>`
  map with **every requested guuid present** (empty array = "no files", distinct from "not fetched").
  `record_guuids` is comma-separated, deduped, capped at **100**
  ([`dto/upload-fields.request.ts:28`](../../apps/backend/src/files/dto/upload-fields.request.ts#L28)).
- **One file** — `GET /stores/:storeId/files/:guuid` → `getFile` (`:311`).

Every read mints a fresh presigned GET (`STORAGE_SIGNED_URL_TTL_SECONDS = 2100`, 35 min) via
`toResponses` (`:365`); the raw key is never returned.

### A3.4 Delete / restore (store-scoped soft-delete → trash)

- **Delete** — `DELETE /stores/:storeId/files/:guuid` → `deleteFile` (`:318`): store-scoped soft-delete
  (`deleted_at`/`deleted_by`). The object is **not** removed (recoverable).
- **Restore** — `POST /stores/:storeId/files/:guuid/restore` → `restoreFile` (`:325`): store-scoped,
  clears `deleted_at`.

### A3.5 Cancel a staged upload

- `DELETE /stores/:storeId/files/temp/:guuid` → `cancelStaged` (`:106`): owner-scoped hard delete of the
  temp row + `safeDelete` of the object — the "cancel my in-progress upload" the legacy app lacked.

---

## A4. Validation & content safety

[`file-validation.service.ts`](../../apps/backend/src/files/file-validation.service.ts) — the **real
gate**; client checks are UX only. The client-declared `mimeType` is **never trusted** for security
decisions.

- **`validateAtIngestion`** (`:34`, at stage): non-empty; size ≤ `min(rule.maxFileSizeBytes,
  UPLOAD_MAX_FILE_SIZE_MB=10MB)`; extension ∈ `rule.validExtensions`; **magic-byte content sniff** —
  `detectKind` recognises JPEG/PNG/GIF/WEBP/BMP/PDF/ZIP (docx/xlsx/pptx are ZIP), and the detected
  signature must match the declared extension. **`isScriptableMarkup`** rejects `<?xml`, `<svg`,
  `<!doctype html`, `<html`, `<script` unless the extension is textual (`csv`/`txt`). **SVG is
  deliberately not a sniffable image** — script-capable markup must never pass an image gate
  (stored-XSS defence).
- **`validateAtCommit`** (`:60`, at commit): `count + 1 ≤ maxAttachmentsAllowed`;
  `existing.totalBytes + file.size ≤ maxConsolidatedSizeBytes`.

---

## A5. Storage provider abstraction & presigned reads

Bound at wire time by [`storage.module.ts`](../../apps/backend/src/files/storage/storage.module.ts): an
`S3StorageProvider` when `STORAGE_BUCKET` is set, otherwise an on-disk `LocalStorageProvider`
(`STORAGE_LOCAL_DIR = .storage`, dev only). The `StorageProvider` interface
([`storage/storage.provider.ts`](../../apps/backend/src/files/storage/storage.provider.ts)):
`putObject`, `deleteObject`, `copyObject`, `getSignedUrl`, `objectExists`.

- **S3** ([`s3-storage.provider.ts`](../../apps/backend/src/files/storage/s3-storage.provider.ts)): AWS
  SDK v3, lazily imported so the app boots with no S3 dependency when local. `putObject` writes
  `ACL: private`; `getSignedUrl` presigns a GET; `copyObject` builds `CopySource` by **encoding each path
  segment while preserving `/`** (a whole-key `encodeURIComponent` turns `/` into `%2F`, which Supabase's
  gateway does not decode → the copy would fail as an opaque 503) and logs the underlying error before
  rethrowing `StorageUnavailableError`.
- **Local dev raw serve** ([`files-raw.controller.ts`](../../apps/backend/src/files/files-raw.controller.ts)):
  `GET /files/raw/:key?exp&sig` — `@Public()`, HMAC-signed; SVG/markup are forced to
  `Content-Disposition: attachment`, only known image types render inline. Never reached when S3 is configured.

Reads are **private + presigned-at-read**: a ~35-min GET URL, regenerated every read, never persisted.

---

## A6. Security & isolation model

**Guard chain** — [`files.controller.ts:52`](../../apps/backend/src/files/files.controller.ts#L52):
`@UseGuards(MobileJwtGuard, TenantGuard, SubscriptionStatusGuard)` + class-level
`@StoreContext('param.storeId')`. `TenantGuard` resolves the store from the path and verifies access,
writing `request.context`; `SubscriptionStatusGuard` **exempts reads** (`GET`/`HEAD`/`OPTIONS` in
`READ_METHODS`) — viewing files is never blocked by a lapsed subscription; only writes
(stage/commit/cancel/delete/restore) are gated.

- **Owner/store isolation is structural** — temps are owner-scoped (`uploaded_by`), committed files
  store-scoped (`store_fk`); no repository method resolves by key/guuid alone
  ([`files.repository.ts`](../../apps/backend/src/files/files.repository.ts)).
- **`store_fk`/`user_id` come from the resolved context**, never the request body (`requireStoreId`/
  `requireUserId`, `files.service.ts:407-417`).
- **The client never chooses the storage key** — the server builds `tmp/{userId}/…` and
  `{storeId}/{entityCode}/{recordGuuid}/{uuid}/{name}` via `safeName`.
- **Commit parent-verify is an isolation control too** — it forecloses committing against another store's
  `record_guuid` (the store-scoped `exists()` and the tenant check agree), and against a `record_guuid`
  that never existed (no phantom rows).
- **Content sniff + extension allow-list + size caps at ingestion**; SVG/markup rejected; the dev
  raw-serve forces attachment disposition.
- **Errors** are typed through the shared exception filter (`AllExceptionsFilter`), which renders a
  consistent envelope and emits `errorCode` in lowercase snake_case (e.g. `file_parent_not_found`).

---

## A7. Scheduled jobs

- **Temp sweeper** — `TempFileSweeperService`, cron `CRON_TEMP_FILE_SWEEP = '15 * * * *'` (hourly). Calls
  `FilesService.sweepExpiredTemps` (`files.service.ts:336`): delete expired, uncommitted `temporary_files`
  rows and their objects (batch 500).
- **Orphan-`files` reaper** — [`orphan-files-reaper.service.ts`](../../apps/backend/src/files/orphan-files-reaper.service.ts),
  cron `CRON_ORPHAN_FILES_REAP = '30 3 * * *'` (daily). For each **registered** entity code, LEFT-JOIN
  finds committed `files` with no live parent (`record-existence.service.ts:findOrphanedFiles`), soft-deletes
  them + their objects (`reapOrphan`), bounded to 20 passes × 500 rows/entity per tick. With the commit
  parent-check in place this should normally find nothing — running it *proves* the invariant and catches
  post-commit parent deletions the app didn't cascade.

---

## A8. API / contract surface

`@Controller('stores/:storeId/files')` — [`files.controller.ts`](../../apps/backend/src/files/files.controller.ts):

| Endpoint | Method | Purpose | Gate |
|---|---|---|---|
| `stores/:storeId/files/temp` | POST (multipart `file` + `entity_type` + `kind`) | Stage one file | write-gated |
| `stores/:storeId/files/temp/:guuid` | DELETE (204) | Cancel a staged upload | write-gated |
| `stores/:storeId/files/commit` | POST `{ entity_type, record_guuid, kind, file_guuids[] }` | Link staged temps to a record | write-gated |
| `stores/:storeId/files` | GET `?entity_type&record_guuid` | List a record's files | read (ungated) |
| `stores/:storeId/files/by-records` | GET `?entity_type&record_guuids=a,b,c` | Batched grid read → map | read (ungated) |
| `stores/:storeId/files/:guuid` | GET | One file (fresh presigned URL) | read (ungated) |
| `stores/:storeId/files/:guuid` | DELETE (204) | Soft-delete → trash | write-gated |
| `stores/:storeId/files/:guuid/restore` | POST | Restore from trash | write-gated |
| `files/raw/:key` | GET `?exp&sig` | Dev-only HMAC raw serve (local provider) | `@Public()` (signed) |

**Stage response:** `{ guuid, file_name, size_bytes, mime_type, sha256, expires_at, preview_url }`.
**Commit / read response (`FileResponse`):** the file metadata + a fresh presigned URL; the raw
`storage_key` is never emitted.

---

## A9. One upload followed end to end (product image)

1. Client stages: `POST /stores/{store}/files/temp` (multipart, `entity_type=Product`, `kind=image`).
2. Backend validates at ingestion (extension/size/content-sniff), writes `tmp/{userId}/{uuid}/{name}`
   (outside any tx), inserts a `temporary_files` row (`expires_at = +24h`), returns `guuid` + a 35-min
   `preview_url`. **201.**
3. The product's create mutation syncs (offline client waits for this — see the mobile doc).
4. Client commits: `POST /stores/{store}/files/commit` `{ entity_type:'Product', record_guuid, kind:'image',
   file_guuids:[guuid] }`.
5. Backend verifies the `Product` exists in this store → resolves the owner's temp → budget checks →
   claims the temp (`claimed_at`) → copies `tmp/…` → `{store}/Product/{record}/{uuid}/{name}` → one tx
   inserts the `files` row and deletes the temp → deletes the staged object. **201.**
6. Later reads (`GET …/files/by-records`) mint fresh presigned GET URLs at read time; the step-2
   `preview_url` has long expired.

---

## A10. Configuration

Env → [`config/env.ts`](../../apps/backend/src/config/env.ts), surfaced via `AppConfigService`:

| Setting | Env var | Default |
|---|---|---|
| Global per-file cap | `UPLOAD_MAX_FILE_SIZE_MB` | 10 MB |
| Presigned URL TTL | `STORAGE_SIGNED_URL_TTL_SECONDS` | 2100 (35 min) |
| Temp staging TTL | `TEMP_FILE_TTL_HOURS` | 24 h |
| Temp sweep cron | `CRON_TEMP_FILE_SWEEP` | `15 * * * *` (hourly) |
| Orphan reap cron | `CRON_ORPHAN_FILES_REAP` | `30 3 * * *` (daily) |
| Object store bucket | `STORAGE_BUCKET` | unset → LocalStorageProvider |
| S3 region/endpoint/keys | `STORAGE_REGION` / `STORAGE_ENDPOINT` / `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` / `STORAGE_FORCE_PATH_STYLE` | — |
| Local store dir (dev) | `STORAGE_LOCAL_DIR` | `.storage` |

---
---

# PART B — HOW THE LEGACY DEFECT CLASSES ARE CLOSED

The rebuild was designed to structurally prevent the legacy Spring Boot pipeline's defects. Mapping:

| Legacy defect (old system) | Structurally closed by (this repo) |
|---|---|
| Real ingestion path ran **zero validation** | `validateAtIngestion` runs at **stage** time, before anything permanent — extension + size + magic-byte sniff (A4). |
| `temporary_files` had **no tenant column** → cross-tenant delete/adopt | Temps are **owner-scoped** (`uploaded_by`); commit resolves temps by `guuid AND uploaded_by`; there is no key-only lookup (A6). |
| Hard-delete-by-id with **no tenant filter / no auth** | One store-scoped soft-delete + restore; deletes require the guard chain + `store_fk` match (A3.4). No numeric-id delete exists. |
| Commit trusted the client about its own parent → **phantom rows** | Commit verifies `(entity_type, record_guuid, store_fk)` → live record or `409 file_parent_not_found` (A3.2), plus a daily orphan reaper that *proves* the invariant (A7). |
| **SVG stored-XSS** (allow-list trusted `Content-Type`) | SVG excluded from the seed allow-list; content sniff rejects scriptable markup; dev raw-serve forces `Content-Disposition: attachment` (A4/A5). |
| **S3 write inside the DB transaction, no timeout** → pool exhaustion | Object writes are **outside** the DB tx (stage: put→insert; commit: copy→tx-insert→delete); the tx is short and DB-only. *(A per-S3-call timeout is still a follow-up — Part C.)* |
| S3/DB **dual-writes never reconciled** (orphans, dangling refs) | Commit copy→tx→delete with compensating deletes + claim release on failure; temp sweeper + orphan reaper are the backstops (A3.2/A7). |
| Non-idempotent commit → **duplicate rows** | `claimed_at` gives **at-most-once row creation** and `uk_files_record_sha` collapses identical re-commits, so no duplicate *live* rows. **Caveat (D4):** this is not a *recoverable* idempotent response — if the server commits but the client loses the response, a retry finds the temp already deleted and gets `TempFileNotFoundError`, not the committed file. |
| Second **DB-blob pipeline** (`FilesHelper`), unvalidated/unscoped | Does not exist — one storage abstraction (S3 or local), no `fileData` blob path. |
| Stored/leaked raw S3 URLs | Presigned-at-read only; `storage_key` never emitted (A2/A5). |
| Quota TOCTOU on an unlocked `SUM` | **Only partially closed (D1).** There is no account-wide quota (deferred), **but the per-record count/consolidated checks have the same read-then-insert TOCTOU** — `assertRecordBudget` reads `recordStats` (`files.service.ts:137`) with no lock, then inserts later, so two concurrent commits to one record can both pass and overshoot. See D1. |

---
---

# PART C — DEFERRED / NOT YET BUILT

- **Per-S3-call timeout** — only the app-wide 30s request timeout bounds an S3 call today; a tighter
  per-call `requestHandler` timeout on the S3 client is a follow-up so a hung object store can't tie up a
  request slot (`s3-storage.provider.ts` documents this).
- **`Product:edit` (per-parent-entity) permission on files routes** — the controller is store-scoped but
  does not yet enforce per-parent CRUD (files are polymorphic; the parent entity isn't known until request
  time). The commit parent-check already resolves the parent, so the permission check is a cheap addition
  at that point.
- **Account-wide storage quota** — no `company_storage`/`used_size_kb` counter; only per-record limits via
  `files_config`. Add if overage becomes a hard capacity constraint.
- **Server-side thumbnails** — the `files.thumbnail_url` column exists but is unpopulated; the client
  renders its own local thumb today. A server thumb worker is deferred.
- **Hard-purge of trashed files** — `deleteFile` soft-deletes (recoverable) but there is **no scheduled
  purge** of soft-deleted committed files past a retention window (only the temp sweeper purges expired
  *uncommitted* temps, and the orphan reaper soft-deletes parentless files). Add a retention-based purge
  when product/compliance defines a window.
- **Attachment surfaces beyond `Product`** — `RECORD_TABLES` in `record-existence.service.ts` registers
  **only `Product`**; committing against any other entity is fail-closed until its table is registered here.
- **Client offline layer** — capture, the local `attachment` table, and the background uploader live in
  the mobile app and are documented in
  [`docs/mobile/image-offline-architecture.md`](../mobile/image-offline-architecture.md), not here. One
  known gap there: no product-grid screen consumes the batched read yet, so cross-device grid display is
  wired end-to-end on the backend but not yet surfaced by a client screen.
- **Presigned-PUT / chunked-resumable / CDN / async scan** — all deferred behind measured-need triggers;
  at current file sizes (100–300 KB downsized images) none is justified.

---
---

# PART D — PRE-PRODUCTION REVIEW FINDINGS (open, verified against code)

An architecture review (recorded here so the gaps are tracked, not lost) surfaced the following. Each is
**verified against the current code**, with severity and the recommended fix. The verdict: the core
design is sound (local capture → durable local queue → wait for parent sync → backend stage → backend
commit → private presigned reads); these are the items to close **before production**.

**Release blockers (do before production):**

- **D1 — ✅ FIXED (HIGH): per-record attachment budget concurrency race.** `persistFiles` now takes a
  **transaction-scoped advisory lock** on `(store, record_guuid)` (`FilesRepository.lockRecordForCommit`
  → `pg_advisory_xact_lock`) and **re-checks the budget inside that locked tx** before inserting
  ([`files.service.ts` persistFiles](../../apps/backend/src/files/files.service.ts)). Two concurrent
  commits to the same record now queue on the lock; the second sees the first's inserted rows and can't
  overshoot `maxAttachmentsAllowed` / consolidated size. The pre-copy check remains as a fast fail. *(The
  `uk_files_record_sha` index still only dedupes identical bytes — orthogonal.)*

- **D2 — ✅ FIXED (HIGH): per-parent-entity authorization.** Every write now requires the parent entity's
  **`edit`** CRUD grant in the store: `FilesService.assertCanEditEntity` calls
  `RbacService.getCachedPermissions` + `checkCrud(entity, 'edit')` on **stage** and **commit** (entity from
  the request), and `assertCanEditEntityById` resolves the file's `entity_type_fk` → code for **delete**
  and **restore** ([`files.service.ts`](../../apps/backend/src/files/files.service.ts),
  [`entity-types.repository.ts` findById](../../apps/backend/src/entity-types/entity-types.repository.ts)).
  Fail-closed: an unknown/unregistered entity has no `edit` grant, so it's denied. A read-only store member
  can no longer stage/commit/delete/restore attachments.

- **D3 — ✅ FIXED (HIGH): `kind=image` accepted non-images (e.g. PDF).** The seed now inserts a
  **kind-specific `image` rule** (`jpg,jpeg,png,webp,gif` — no PDF) alongside the entity-wide null-kind
  fallback for every attachment-supporting entity ([`db/scripts/seed.ts`](../../apps/backend/src/db/scripts/seed.ts)).
  `findRule` prefers the kind-specific rule, so `kind='image'` now rejects a PDF at ingestion. *(Requires
  re-running the seed against existing environments to add the `image` rules.)*

**Correctness / robustness (close before or shortly after launch):**

- **D4 — MEDIUM: commit is not retry-idempotent on a lost response.** `claimed_at` prevents two commits
  from consuming the same temp, and `uk_files_record_sha` prevents duplicate live rows — but if the server
  commits successfully and the **client loses the response**, the retry finds the temp already deleted
  (`persistFiles` deletes it in-tx) and gets `TempFileNotFoundError` (404), which the offline uploader then
  marks `failed` even though the file *was* committed. **Fix:** accept a durable client
  attachment/idempotency key at commit and return the prior committed `FileResponse` for a repeated
  request. Only after this is "idempotent effect" accurate (A/B previously overstated it).

- **D5 — MEDIUM: separate subscription-blocked from permission-denied on the client.** The **code** already
  does the right thing — only `startsWith('subscription')` → `blocked`; a permission 403 falls through to
  `failed` ([`image-uploader.ts:358`](../../apps/mobile/src/core/sync/image-uploader.ts#L358)). The
  **mobile doc** was self-contradictory (said both). It is now corrected: subscription lapse → `blocked`
  (auto-requeue on `subscription_version` bump); permission denied → `failed` (re-evaluated only on a
  permission change). This matters once D2 lands and 403s actually occur on these routes.

- **D6 — ✅ FIXED (MEDIUM): sweeper vs. commit-claim race.** `findExpiredTemps` now reaps only rows that
  are **unclaimed, or whose claim is older than a grace window** (`TEMP_FILE_CLAIM_GRACE_MINUTES`, default
  60) — so it can't delete a temp a commit just claimed, while a claim left by a crashed commit is still
  eventually recovered ([`files.repository.ts` findExpiredTemps](../../apps/backend/src/files/files.repository.ts),
  [`files.service.ts` sweepExpiredTemps](../../apps/backend/src/files/files.service.ts)). *(Follow-up: an
  integration test that runs commit at the expiry boundary while the sweeper executes.)*

- **D7 — ✅ FIXED (MEDIUM): no per-S3-call timeout / cancellation.** Each object-store call now runs with a
  per-call `AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS)` (default 15 s) and the S3 client sets
  `maxAttempts` (`STORAGE_MAX_ATTEMPTS`, default 3) for bounded retries
  ([`s3-storage.provider.ts`](../../apps/backend/src/files/storage/s3-storage.provider.ts)) — a hung store
  can no longer hold a request slot, independent of the global request timeout.

- **D8 — MEDIUM (OPEN): cross-device grid display is not wired.** The batched read (`/files/by-records`), the
  api-manager hook, and `RecordImage.remoteFile` all exist, but **no product-grid screen consumes them**,
  so the cross-device-visibility promise isn't delivered yet (tracked in the mobile doc). **Fix:** wire
  the product grid to the batched read.

**Lifecycle / policy (decisions still needed):**

- **D9 — LOW:** trash retention + hard-purge window; account/store storage quota; **server-generated
  thumbnails** (especially valuable — cross-device grids currently download full-size images); malware
  scanning if general documents remain supported. All deferred (Part C) pending product/compliance
  decisions.

---

*This is the backend architecture of record for file/image upload as built in `apps/backend/src/files`.
The client-side offline capture/upload/display layer is documented in
[`docs/mobile/image-offline-architecture.md`](../mobile/image-offline-architecture.md). Keep both in sync
as the feature evolves.*
