# Image / File Upload — Architecture (Final, Consolidated)

> **The single authoritative architecture document for the image/file upload feature.** It consolidates
> the three working documents in this folder into one clean reference:
> - `image-upload-flow.md` — the end-to-end flow trace (every path, `file:line`).
> - `image-upload-flow-review.md` — the four-lens review (Critic / Decision / Backend-Standard / Architect).
> - `image-upload-testcases.md` — the BA+QA test-case & acceptance set.
>
> It spans two repositories:
> - **Backend** — `/Users/saran/Downloads/ayphen-3.0` — Spring Boot, package `com.ayphen.api`, S3 + Postgres.
> - **Frontend** — `/Users/saran/ayphen-mobile/ayphen-frontend` — Nx monorepo: `apps/ayphen-mobile`,
>   `apps/engage-mobile`, `apps/portal`, shared `libs-mobile/*`, `libs-web/*`, `common/*`.
>
> **How to read this document.** Part A describes the system **as it is today** (current architecture,
> every flow, the data model, the contract). Part B is the **defect register** (what's wrong, ranked).
> Part C is the **target architecture** (the decided end-state and how to get there). Every factual claim
> about current behaviour is cited `file:line`; every "should be" is labelled as target, not current.

---

## Table of contents

- **Part A — Current architecture (as-is)**
  - A1. System context & the shared pipeline
  - A2. Data model
  - A3. Backend flows (6) — upload, retrieve, delete, edit, DB-blob pipeline, mail
  - A4. Frontend flows (11 surfaces) — mobile + web
  - A5. API / contract surface
  - A6. File lifecycle state machine
  - A7. One upload followed end to end
  - A8. Where flows diverge or duplicate
- **Part B — Defect register**
  - B1. Corrections to the original trace (errata)
  - B2. Findings, ranked P0 → P3
- **Part C — Target architecture (to-be)**
  - C1. The decision, in one paragraph
  - C2. Target data model & authority
  - C3. Target upload / link / retrieve / delete flows
  - C4. Concurrency, idempotency, failure semantics
  - C5. Security & isolation model
  - C6. Build order & what to defer
  - C7. Acceptance criteria (traceable to test cases)
  - C8. Open questions

---
---

# PART A — CURRENT ARCHITECTURE (AS-IS)

## A1. System context & the shared pipeline

The feature lets an authenticated tenant user attach a file (image, PDF, Office doc, CSV) to a business
record — a docket/receipt, a ticket, a customer/supplier/employee/company logo, a bank statement, a
supplier price file. Inbound email attachments enter the same backend pipeline.

**Actors**
- **Authenticated tenant user** (web portal / two mobile apps) — picks, uploads, links, views, deletes.
- **Inbound email sender** (external, untrusted) — attachments ingested via MS Graph API.
- **A second tenant's user** — the adversary in every isolation concern.
- **Scheduled jobs** — *none today* touch files (a reaper is a target-state addition).

**The shared pipeline every surface converges on:**

```
┌──────────────┐   ┌──────────────────┐   ┌─────────────────────┐   ┌───────────────────┐   ┌──────────────┐
│ Pick/capture │ → │ Upload to "temp" │ → │ S3 write + a         │ → │ Link fileKey(s) to │ → │ Retrieve via │
│ (picker /    │   │ multipart POST   │   │ TemporaryFile row    │   │ the parent record  │   │ presigned    │
│  dropzone)   │   │ files/temp/upload│   │ (NO tenant column)   │   │ on save (promote)  │   │ GET URL      │
└──────────────┘   └──────────────────┘   └─────────────────────┘   └───────────────────┘   └──────────────┘
```

**Two invariants of the current design:**
1. **No presigned-PUT-from-client.** The client always sends raw bytes/URI through the backend; the
   backend owns the S3 write. Presigned URLs appear only on the **read** side.
2. **Two-phase (stage → link) is the norm; one-step is the exception.** Ticket attachments (A4.7) upload
   directly against the ticket entity in one call; everything else stages to a temp table first, then
   links `fileKey`s on parent-record save.

---

## A2. Data model

DDL under `/Users/saran/Downloads/ayphen-3.0/src/main/resources/db-scripts/`. Java entities under
`com.ayphen.api.domain` / `...entity`.

| Table | Role | Key columns | Tenant scoped? | Notes |
|---|---|---|---|---|
| `files` | Permanent, linked files (source of truth) | `id`, `file_key`, `entity_fk`, `record_id`, `file_type_fk`, `company_fk`, `file_url`, `file_data` (BLOB), `is_active`, `deleted_by/date` | Yes (via `company_fk`) | **Polymorphic** owner pointer `(entity_fk, record_id)` with no real FK. `company_fk` is `NULL`-able in DDL but `@Column(nullable=false)` in the entity — a contradiction (see B2/P2-11). |
| `temporary_files` | Staged, not-yet-linked uploads | `id`, `file_key`, `file_name`, `file_url`, `is_active` | **NO — no company/tenant column at all** | Structural isolation gap (B2/P0-4). Ephemeral by intent (minutes–hours) but reaped by nothing today. |
| `files_config` | Per-`(entity, fileType)` validation rules | `entity_id`, `file_type_id`, `max_file_size`, `max_consolidated_size`, `valid_extensions`, `max_attachments_allowed` | via `entity`/`file_type` FKs | The only table here with real DB referential integrity (not polymorphic). Drives all of BR1–BR4. |
| `company_storage` (`CompanyStorageAllocation`) | Per-company storage quota | `company_fk`, `allocated_size` (default **1GB** = 1048576 KB) | Yes | Quota is checked by a live `SUM(fileSizeKb)` read, not a maintained counter (B2/P1-5). |
| `StorageArea` | (adjacent to the storage domain) | — | — | In the model cluster; not on the hot upload path. |

**Data authority.** The `files` row is the source of truth for "this file exists and is linked here."
S3 is a dumb blob store. Product/customer/supplier/employee/company images are **not** denormalised URL
columns — they are joined at read time from `files` via `(entity_fk, record_id, file_type_fk)`. This is
a genuinely good design choice (no dangling-URL-on-rename bugs) and is preserved in the target.

---

## A3. Backend flows (`ayphen-3.0`)

Citations are `file:line` under `.../com/ayphen/api/`.

### A3.1 — Upload (the VALIDATED endpoint `POST /api/v1/files/upload`)

`FilesController.java:43-54` → `FilesServiceImpl.processFileUpload` (`FilesServiceImpl.java:634-688`).
**Note (see B1):** this endpoint is fully validated but the **frontend does not currently call it** —
the frontend calls the *unvalidated* temp endpoint in A3.1b. This flow is documented because it is the
model the target adopts.

1. Receives multipart file + `recordId`, `entityId`, `fileType`, `description`, `tenantId`. **No
   `@PreAuthorize`.**
2. Resolves the owning `Entities` row; builds the S3 key
   `{companyGuuid}/entities/{entityName}/{recordId}/{UUID}/{originalFilename}` (`:641-649`) — filename
   embedded **raw**, unsanitized.
3. Resolves `Company` by guuid — optional; proceeds with `null` company if unresolved (`:653-658`).
4. **Validates** — `commonUtils.validateFileUploadRestrictions(...)` (`:661-662`): `FilesConfig` lookup
   (throws if missing) → **quota** (`CompanyStorageAllocation.allocatedSize` vs a live
   `SUM(fileSizeKb)` from `calculateTotalUsedStorageByCompany`, no lock) → per-file size → consolidated
   size → extension allow-list → attachment count.
5. **S3 write** — one `PutObjectRequest`, `ACL.PRIVATE` (`:665, 881-891`).
6. **DB insert** — the `Files` row; `fileUrl` set to the raw (non-presigned) S3 URL (`:671, 684`).
7. **Response** — a `FilesDTO` carrying both the raw `fileUrl`/`fileKey` **and** a fresh presigned URL.

**Ordering / failure:** steps 5–6 are inside one class-level `@Transactional(rollbackOn=Exception.class)`
(`:55`). **S3 write precedes DB insert** — if the insert throws, the DB rolls back but the S3 object is
orphaned forever; no reconciliation job exists.

### A3.1b — Upload (the endpoint the frontend ACTUALLY calls, `POST /api/v1/files/temp/upload`)

`FilesController.java:152-153` (no `@PreAuthorize`) → `FilesServiceImpl.uploadToTemporaryStorage`
(`FilesServiceImpl.java:832-867`).

1. Receives **only** a raw `MultipartFile` — no `recordId`/`entityId`/`fileType`/`tenantId`.
2. **Runs none of the six validation checks.** No extension check, no per-file/consolidated size check,
   no attachment-count check, no quota check, no company binding. The only ceiling is Spring's blanket
   `spring.servlet.multipart.max-file-size: 20MB`.
3. Writes to S3 and inserts a `temporary_files` row (which has no tenant column).
4. Validation happens **later, only at promotion/link time** (`validateTempFileUploadRestrictions`,
   6 call sites) — and only if the user completes the parent-record save.

This is the real ingestion path for every frontend surface except ticket attachments. It is the origin
of the two headline P0s (unvalidated write, no tenant attribution).

### A3.2 — Retrieve

- `getFilesByRecordId`, `getFileByGuuid`, `getFilesByCompanyIdAndFileType` return `FilesDTO`/
  `Page<FilesDTO>` with a presigned URL generated **at read time** (`ConversionUtils.generatePreSignedUrl`,
  35-min expiry, `ConversionUtils.java:1211,1223`). Never stored.
- **No byte-streaming/proxy endpoint** — nothing streams S3 bytes through the backend (`getInputStream`,
  `:1413`, is internal-only, for PDF building).
- Every retrieval path is **tenant-scoped** (`findByCompanyIdAndGuuidAndIsActiveTrue` `:2449`;
  `getFilesByCompanyIdAndFileType` also filters by accessible location IDs `:580-605`) — **except** the
  `FilesHelper` path (A3.5) and the raw `fileUrl` field riding alongside every response.
- **Failure smell:** `generatePreSignedUrl` swallows `SdkClientException` and returns the literal string
  `"Error generating pre-signed URL"` instead of `null`/throw (`:1223-1227`) — a broken link rendered as
  if real.

### A3.3 — Delete (THREE mechanisms coexist)

**(A) Hard delete by numeric id** — `FilesController.deleteFile(Long id)` (`:90-93`, **no
`@PreAuthorize`**) → `FilesServiceImpl.deleteFile(Long id)` (`:468-487`): `findByIdAndIsActiveTrue(id)`,
**no company filter**, deletes the S3 object, sets `isActive=false`. Any authenticated user of any tenant
can permanently destroy another company's file by guessing a sequential id. **No recovery** (real S3
delete, not trash).

**(B) Tenant-scoped soft-delete-to-trash by key** — `FilesController.deleteFile(UUID tenantId, ...)`
(`:174` region) → `deleteFile(UUID tenantId, List<String> fileKeys)` (`:2120-2216`): resolves
`companyId` from `tenantId`; permanent rows are scoped by `fileKey AND companyId` (`:2163,2195`,
**correct**); **temp rows** are looked up by `fileKey` alone (`:2172,2216`, **no company filter** —
structural, `temporary_files` has no column). `restoreFile` (`:2284-2329`) is correctly scoped
(`findByFileKeyAndCompanyIdAndIsActiveFalse`). Trash-move (`moveFileInS3`/`moveFileToTrashInS3`,
`:922-936,1743`) is copy-then-delete with no rollback.

**(C) Delete-and-move-to-trash by key** — `DELETE /api/v1/files/delete` →
`deleteFileFromTempAndMoveToTrash` (`FilesController.java:95-98`, **no `@PreAuthorize`, no tenant param**),
resolves a `Files` row by `fileKey` + `isActive` only, no company filter. Same severity as (A).

### A3.4 — Edit / update

`updateFile(id, newFile, companyGuuid)` → `processFileUpdate` (`:704-753`): **deletes the old S3 object
first (`:720`), then uploads the new (`:727`)**, then updates the row. If the new upload fails after the
old delete, the row stays **active** pointing at a deleted key — a dangling reference invisible until
someone fetches it. `editFileMetadata` (`:2364-2388`) only touches link metadata and is correctly
tenant/existence checked.

### A3.5 — Second upload pipeline: `FilesHelper` (DB-blob, bypasses S3)

`utility/helper/FilesHelper.java` — a **complete second pipeline** (`addFile`/`addFiles`/`updateFile`/
`updateFiles`/`softDeleteFileById(s)`/`getFileByFileId`/`getFilesByFileIds`/`getFilesByEntityIdAndRecordId`),
storing raw bytes into the `Files.fileData` BLOB (`:75`). No S3. Validation is a non-null check only
(`:246,257`) — none of the six rules. **No `companyId` filter on any lookup.** **Confirmed dead code**
(see B1): zero HTTP-reachable callers. It is live, compiled, DI-wired code with no entry point — a
loaded landmine.

### A3.6 — Mail attachments

`FilesController.uploadMailAttachments` (`:172-182`) → `FilesServiceImpl.uploadMailAttachments`
(`:1926-2037`): reuses `validateTempFileUploadRestrictions` (`:1986-1994`) with
`fileTypeId = LK_FILE_TYPE_UN_CATEGORISED_DOC`; per-file exceptions are caught and logged to `MailAudit`
(intentional partial-success). **Defect:** the S3 key is built **without** a `UUID` segment (`:2000`):
`{companyGuuid}/entities/{entityName}/UnCategorisedDocs/{originalFilename}` — deterministic; same-named
attachments silently overwrite. **Inbound email** (`EmailReaderService.java:441`) wraps raw `byte[]` in
`config/ByteArrayMultipartFile.java` and flows through this exact pipeline — attacker-controlled
filenames/content hit the same key-construction and content-type-trusting logic as a browser upload.

---

## A4. Frontend flows (`ayphen-frontend`)

Citations relative to `/Users/saran/ayphen-mobile/ayphen-frontend/`.

### A4.1 — Mobile docket/receipt upload (the ONE real mobile flow) — `apps/ayphen-mobile`

`src/pages/dashboard/upload-documents/form/index.tsx:72-136` + `src/utils/attachment/hooks.tsx`.
1. **Pick a File** → `pickDocument` (`hooks.tsx:22-40`): `DocumentPicker.getDocumentAsync({type:"*/*"})` —
   **no type restriction**. **Bug (`:36`):** `uploadFileTos3({...file, fileName: file})` passes the whole
   asset object as `fileName` → corrupted filename.
2. **Pick from Gallery** → `pickImage` (`:42-60`): explicit `requestMediaLibraryPermissionsAsync()`,
   `Alert` on denial; `launchImageLibraryAsync({mediaTypes:["images"], quality:0.2})` — the only
   compression is the 0.2 quality knob.
3. Dispatches `uploadFileMobile`. **FormData bug (`api-handler.ts:262-299`):** appends `"file"` **twice**
   (a bare string, then the RN file object). The web sibling `generateAsyncThunkForMultipart` (`:222-260`)
   does the single correct append.
4. POSTs to `v1/public/files/temp/upload`; bearer token attached; **no request timeout configured.**
5. **Success:** `setAttachments(...)` + success `Alert`. **Failure:** `.catch(err => console.log(err))` —
   **nothing shown to the user, no retry, no offline queue.**
6. **Delete** (`:89-102`) is **local-only** — never calls the backend; staged into `deletedAttachments`.
7. **Save** — `gerenareRequestData()` (`:104-129`) flattens to `{create:{fileKey:[...]}, delete:{fileKey:[...]}}`
   in the parent save payload.
8. **No double-tap guard** on the pick buttons (`form/index.tsx:104-121`).

### A4.2 — Mobile `ImagePickerComponent` shared lib (DEAD)

`libs-mobile/mobile-components/src/lib/ImagePicker/index.tsx:27-40`: `launchImageLibraryAsync({quality:1,
allowsEditing:true, aspect:[4,3]})`, **no permission-denial handling, no upload call**. **Zero consumers**
in either mobile app. A second, divergent picker implementation.

### A4.3 — `engage-mobile` — Attachments (NON-FUNCTIONAL)

`apps/engage-mobile/.../project-detail/overview/index.tsx:250-266` — a static "No attachments found"
placeholder. No picker, no upload, no state. `expo-image-picker` is a dependency with no consumer.

### A4.4 — Web generic multi-file `Attachments` widget

`apps/portal/src/components/Attachments/index.tsx` (+ `utils.ts`, `hooks.ts`, `AttachmentsListView.tsx`).
`beforeUpload` (`utils.ts:37-84`): count vs `maxAttachments` (default 10), type allow-list (images+PDF+
Office+CSV), **size check present but commented out (`:70-80`)**. `customRequest` dispatches `uploadFile`
(correct single-append builder); success/failure both surfaced via `notification`; a real double-submit
guard drives `disabled`/`loading` (`:159-163,186-193`). Delete is local-only until parent save.

### A4.5 — Web single-file `UploadAttachment` dropzone

`apps/portal/src/components/UploadAttachment/index.tsx:61-120`. Same shape, single file; type checked,
**size check commented out (`:107-117`)**; double-submit guard reads the **global**
`fileServiceSlice.uploadFileState` (`:125`) — shared app-wide, so an unrelated widget's upload can flip
this one's `isLoading`.

### A4.6 — Web profile image / company logo

`apps/portal/src/components/ProfileImage/index.tsx`. antd `Upload` wrapped in `ImgCrop`. `beforeUpload`
validates jpg/jpeg/png **and an ACTIVE `<1MB` size check** — the **only** surface where the size check is
live. Local-state until parent save; on save `logoRequestData(...)` feeds `bodyParam.files.logo`. Company
logo (`.../company/components/general-form.tsx`) reuses this exact component + `useLogo` hook.

### A4.7 — Web ticket attachments, post-creation (WORKING, the reference flow)

`apps/portal/src/tickets/tickets/ticket-details/ticket-attachments.tsx:151-184`. `customRequest`
dispatches `addTicketAttachment` directly with the raw `Blob` and `pathParam:{tenantId, public:appCode,
id:ticketId}` → `v1/public/{tenantId}/tickets/{id}/attachments` — **one-step, entity-attached, tenant-
scoped by construction**. Control disabled during upload. **Delete is fully wired** (`deleteTicketAttachment`
→ `v1/public/{tenantId}/tickets/attachments/{id}`) — a real backend delete, unlike every other surface.

### A4.8 — Web ticket attachments, create/edit form (BROKEN — silent data loss)

`apps/portal/src/tickets/tickets/ticket-form/ticket-form-hooks.tsx`. Files upload and get real `fileKey`s
(user sees them attached with a success notification), but the linking line in both `onCreateTicket` and
`onEditTicket` is **commented out**:
```ts
// files: { logo: ..., attachments: attachmentRequestData(attachments.value, attachments.deletedValues) },
```
Net effect: files are uploaded, shown as attached, then **silently dropped** — orphaned in
`temporary_files`, never linked, no error surfaced.

### A4.9 — Web docket/receipt upload (Books)

`apps/portal/src/books/UncategorizedDockets/UploadDocket.tsx`. Embeds the generic `Attachments` widget
(`allowedFileTypesForUncategorised` = PDF/JPG/PNG/XLS/XLSX/CSV/DOC/DOCX/PPT/PPTX). On Save, `fileKey`s
are POSTed as JSON to `v1/public/files/tenant/{tenantId}/upload-uncategorized`. **Separately**, the
"permanently delete" handler in `DeletedDocketsList.tsx` has its **entire body commented out** — the
button does nothing (only "restore" works).

### A4.10 — Web "attach existing doc" drawer (NOT an upload surface)

`apps/portal/src/components/UploadUncategorizedDockets/DocketsList.tsx` — a read-only picker that GETs
already-uploaded docs and attaches an existing one to another record. No file input, no validation, no
delete. Links via the record's `preSignedUrl` directly, with **no expiry/refresh** if it has lapsed.

### A4.11 — Web bank statement / supplier price file (not image-relevant)

`.../Reconciliation/UploadBankStatement/index.tsx`, `.../Suppliers/.../UploadPriceFile/index.tsx` —
"upload + server-side parse-preview" for XLS/XLSX/CSV. Included only because they share the same
**size-check-commented-out** pattern, confirming it's systemic across the upload component family.

---

## A5. API / contract surface

| Endpoint | Method | Called by | Auth today |
|---|---|---|---|
| `v1/public/files/temp/upload` | POST | A4.1, A4.4, A4.5, A4.6, A4.8, A4.9 (real ingestion) | Authenticated; **no `@PreAuthorize`**; **no validation** (A3.1b) |
| `v1/public/files/temp/upload` | DELETE | **Nobody** (zero call sites) | — |
| `v1/public/files/tenant/{tenantId}/upload-uncategorized` | POST | A4.9 (link step) | tenant-scoped |
| `v1/public/files/files/{tenantId}/{fileTypeId}` | GET | A4.10 (list existing) | tenant-scoped |
| `v1/public/{tenantId}/tickets/{id}/attachments` | POST | A4.7 (one-step upload) | tenant-scoped |
| `v1/public/{tenantId}/tickets/attachments/{id}` | DELETE | A4.7 (real delete) | tenant-scoped |
| `POST /api/v1/files/upload` | POST | *(validated backend endpoint, currently unused by FE)* | **no `@PreAuthorize`** |
| `DELETE /api/v1/files/delete/{id}` | DELETE | Backend hard-delete-by-id (A3.3-A) | **no `@PreAuthorize`, no tenant filter** |
| `DELETE /api/v1/files/delete` | DELETE | Backend delete-to-trash-by-key (A3.3-C) | **no `@PreAuthorize`, no tenant filter** |
| `/tenant/{tenantId}/...` (delete/restore/edit/mail/statement) | various | Backend tenant-scoped routes | `@PreAuthorize` applied |

**Upload response body** (`ApiResponse.body`): `{ id, name, fileKey, fileSizeKb, fileType, fileUrl,
preSignedUrl, mimeType, description }`. Note `fileUrl` (raw, non-presigned S3 URL) is returned alongside
`preSignedUrl` — redundant and a leak (B2/P1-3).

---

## A6. File lifecycle state machine

```
        (upload)             (link on save)          (delete)           (restore)
[none] ────────► [TEMP/staged] ──────────► [PERMANENT/active] ────────► [TRASHED] ────────► [PERMANENT/active]
                     │                            │  ▲                      │
                     │ (abandoned:                │  │ (update: replace)    │ (permanent delete)
                     │  never linked)             │  └───────┘              ▼
                     ▼                                                   [PURGED/gone]
                [ORPHAN — no reaper today]
```

- **Legal:** none→temp, temp→permanent, permanent→trashed, trashed→permanent, trashed→purged,
  permanent→(replace)→permanent.
- **Must be rejected:** restore a non-trashed file; link an already-linked/purged key; delete an
  already-trashed file twice; act on another tenant's file in any state.
- **Broken today:** temp→orphan has no reaper (accumulates forever); trashed→purged is dead on the web
  Deleted-Dockets screen (commented-out handler).

---

## A7. One upload followed end to end (worked example — mobile docket photo)

1. User taps **Pick from Gallery** in `UploadDocket`.
2. `requestMediaLibraryPermissionsAsync()` → granted.
3. `launchImageLibraryAsync({mediaTypes:["images"], quality:0.2})` → local asset.
4. Client-side transform: only the 0.2 JPEG re-encode; no resize.
5. `uploadFileTos3` dispatches `uploadFileMobile`.
6. `generateAsyncThunkForMultipartUri` builds FormData — appends `"file"` **twice** (bug).
7. POST `v1/public/files/temp/upload`, bearer token, **no timeout**.
8. Backend `uploadToTemporaryStorage` — **no validation**, no company binding.
9. S3 `PutObjectRequest` (`ACL.PRIVATE`); `temporary_files` row inserted (no tenant column).
10. Response: `fileKey`, raw `fileUrl`, `preSignedUrl` (35-min).
11. Client pushes `response.body` into local `attachments`; success `Alert`.
12. User **Saves** the docket → `{create:{fileKey:["<key>"]}}` in the save payload.
13. Backend **link step** (`upload-uncategorized` for dockets) looks up the temp row **by key alone**,
    validates *now* (`validateTempFileUploadRestrictions`), promotes it to a permanent `files` row.
    ⚠️ **The exact promotion mechanism (S3 move vs. key re-point) is untraced — the one open question.**
14. Later retrieval regenerates a **fresh** presigned URL at read time; the step-10 URL is long expired.

---

## A8. Where flows diverge or duplicate

- **Two mobile pickers** — the live one (`hooks.tsx`, quality 0.2, permission-handled, wired to upload)
  vs. the dead `ImagePickerComponent` (quality 1, no permission handling, no upload). Neither is a
  superset.
- **Duplicated request-shaping** — `attachmentRequestData`/`gerenareRequestData` copy-pasted between
  `apps/ayphen-mobile/.../util.ts` and `apps/portal/.../Attachments/utils.ts` instead of shared in
  `common/`.
- **Size-check-commented-out** — the same disabled block in ≥4 files (one copy-paste origin).
- **Delete semantics differ** — ticket attachments delete for real; every other surface is local-only
  until parent save; the `DELETE temp/upload` endpoint has zero callers.
- **Two upload-completion models** — generic temp-then-link vs. one-step entity-attached (tickets only);
  the ticket create/edit form mixes them and breaks (A4.8).
- **Two backend storage pipelines** — the S3 path and the dead DB-blob `FilesHelper` path, sharing the
  `Files` table and the `FilesService` interface but with different validation/tenant guarantees.

---
---

# PART B — DEFECT REGISTER

## B1. Corrections to the original trace (errata)

Independent re-verification (three of the four review lenses re-traced source) corrected the following:

1. **The frontend hits the UNvalidated temp endpoint** (A3.1b), not the validated `processFileUpload`
   (A3.1). This is the single most important correction — it turns "upload is validated" into "the real
   ingestion path has zero validation."
2. **`FilesHelper` is confirmed dead code** — zero HTTP-reachable callers (A3.5).
3. **A third delete mechanism exists** — `DELETE /api/v1/files/delete` (A3.3-C), same severity as A3.3-A.
4. **The global exception handler cannot catch real exceptions** — same-package custom classes named
   `Exception`/`IOException`/`IllegalArgumentException`/`IllegalStateException` shadow the JDK types the
   handlers declare; confirmed via bytecode. Affects error handling for **every** flow.
5. **Auth model confirmed** — the unscoped endpoints require authentication (Spring's default
   `anyRequest().authenticated()`); what's missing is `@PreAuthorize` (the tenant/permission check), so
   the exposure is "any authenticated user of any tenant," not anonymous.
6. **Confirmed** — default quota is **1GB**; **no** scheduled job reaps abandoned temp files/S3 objects.

## B2. Findings, ranked P0 → P3

**P0 — critical (auth bypass / tenant leak / data loss / hang):**
- **P0-1** Global exception handler catches nothing real (errata #4). Wrong response shape for every
  failure; a `ResourceNotFoundException` even returns HTTP 200 with a 404 body.
- **P0-2** The real ingestion endpoint (`/temp/upload`) runs **zero validation** (A3.1b). Any
  authenticated user uploads any type up to 20MB, unattributed to any company.
- **P0-3** Hard-delete-by-id has no tenant filter and no `@PreAuthorize` (A3.3-A). Cross-tenant
  irreversible destruction. *(Third delete mechanism A3.3-C is the same severity.)*
- **P0-4** `temporary_files` has no tenant column (structural). Cross-tenant delete **and** cross-tenant
  link/adoption at promotion (A3.3-B temp branch; the ~90-call-site link path).
- **Also P0 (cross-lens):** SVG accepted as an image type + no content sniffing → stored-XSS
  (server-side allow-list trusts the client `Content-Type`).

**P1 — high (race / missing tx / non-idempotent / fail-open):**
- **P1-5** Quota check is a live unlocked `SUM` — TOCTOU race; two concurrent uploads overshoot.
- **P1-6** S3 client has no timeout/retry and the S3 call runs inside the DB transaction → connection-pool
  exhaustion under S3 latency.
- **P1-7** S3/DB dual-writes are never reconciled — create-path orphan, update-path dangling reference,
  batch-delete partial rollback. No reaper.
- **P1-8** `generatePreSignedUrl` returns a fake "URL" string on failure and logs via raw stdout.
- **Frontend P1s:** mobile FormData double-append (A4.1); document-picker filename corruption (A4.1);
  mobile swallows upload errors (A4.1); no client timeout (A4.1); ticket-form silently drops attachments
  (A4.8); size checks commented out on every surface but the logo (A4.4/4.5); no idempotency key.

**P2 — architecture / over- or under-engineering:**
- **P2-9** `FilesHelper` dead code (retire it). **P2-10** Missing indexes on every hot query column
  (`company_fk`, `record_id`, `entity_fk`, `file_type_fk`, `file_key`). **P2-11** `Files.companyId`
  entity annotation (`nullable=false`) contradicts the DDL (`NULL`-able) → silently null-tenant rows.
  **P2-12** No rate limiting despite a working mechanism used elsewhere. **P2-13** No correlation/trace-id
  infrastructure. **P2 (FE):** global non-keyed upload state (A4.5); dead RTK-Query API; two mobile
  pickers; permanent-delete dead handler (A4.9).

**P3 — nits:** mail-attachment S3 key lacks a UUID segment (collision); `files_config.is_active` index
commented out; duplicated request-shaping helpers; stale/redundant raw `fileUrl` in responses.

**Definition-of-Done scorecard (backend, 15 items):** 0 pass, 4 partial, 11 fail — including *Client never
trusted / every tenant query scoped* (FAIL), *limits claimed atomically* (FAIL), *input validated at the
boundary* (FAIL), *errors typed/consistent* (FAIL), *risky logic tested* (FAIL — two test files in the
whole repo, neither covering this feature).

**What is genuinely well-built (preserve):** the tenant-scoped `/tenant/{tenantId}/...` route family (the
template to fix everything else toward); presigned-at-read-time retrieval; `ACL.PRIVATE` + presigned-GET-
only; the join-at-read-time image model; the mail batch's partial-success design; the six `CommonUtils`
checks (thorough where wired — the problem is reach, not design).

---
---

# PART C — TARGET ARCHITECTURE (TO-BE)

## C1. The decision, in one paragraph

Keep backend-mediated multipart upload (reject direct-to-S3 presigned-PUT for now — file sizes here
don't justify moving validation off the server). **Harden the temp stage rather than delete it:** add a
tenant column to `temporary_files` and move validation to raw-upload time. **Migrate every "parent record
already exists at attach time" surface to the one-step, entity-attached pattern** (the ticket-attachments
flow, A4.7, already proves it works and is tenant-scoped by construction), keeping the two-step
temp-then-link shape **only** for genuine "attach before the parent exists" flows (new docket, new
ticket, new logo). **Retire `FilesHelper`** (dead, unvalidated, unscoped). **Consolidate three delete
mechanisms into one** tenant-scoped soft-delete-to-trash + scheduled purge. **Fix the quota race** with an
atomic counter. Reject chunked/resumable upload and async scan/transcode as unneeded machinery now
(revisit only on a named trigger). This is hardening + a scoped migration, **not** a rewrite.

Design axes decided (from the Architect lens): **A2** collapse to one pipeline · **B2** add the tenant
column (don't eliminate the split) · **C2** one soft-delete path + scheduled purge · **D2** keep the
polymorphic pointer + compensating controls · **E1** keep presigned-at-read (no cache/CDN/proxy) · **F3**
atomic counter for quota (with `SELECT … FOR UPDATE` as an acceptable interim).

## C2. Target data model & authority

- **`files`** stays the single source of truth. Tighten `company_fk` to **`NOT NULL`**, validated at
  write time through **one shared access helper** (not scattered `save()` calls). Add composite indexes:
  `(company_fk, is_active)`, `(file_key)`, `(record_id, entity_fk, file_type_fk, is_active)`.
- **`temporary_files`** gains **`company_fk`** (populated from the authenticated principal at upload
  time, never from client input) and a **`status` column** (`PENDING`/`COMMITTED`/`FAILED`). Add
  `(file_key)` index. Still ephemeral.
- **`company_storage`** gains a materialised **`used_size_kb`** counter, backfilled once from the existing
  `SUM`, which remains the rebuild source of truth if the counter drifts.
- **`files_config`** unchanged (already has real referential integrity).
- **Polymorphic `(entity_fk, record_id)`** pointer stays (D2) — a per-entity FK table for ~90 consumers
  would contradict the one-implementation design; instead add a guarded write helper + an **orphan-audit
  job** that makes a stale `record_id` *detectable and rebuildable*, not DB-prevented.

## C3. Target upload / link / retrieve / delete flows

**Upload (validated, tenant-attributed, at ingestion):**
1. Client uploads to the temp endpoint **with** the authenticated tenant context.
2. The endpoint runs the existing `validateTempFileUploadRestrictions` **immediately** (extension, size,
   consolidated size, count, quota) — using the newly-required `company_fk`.
3. Short transaction inserts `temporary_files` with `status=PENDING` + `company_fk`; S3 write happens
   **outside** the DB transaction; short transaction flips `status=COMMITTED` (or `FAILED`).

**One-step (for surfaces where the parent already exists — the default going forward):** upload directly
against the parent entity's endpoint (like tickets), tenant-scoped by construction, no floating temp
state, no orphan class.

**Link/promotion (only for pre-save attach flows):** look up the temp row **by `fileKey` AND
`company_fk`** (closes the cross-tenant adoption gap); promote to a permanent `files` row; a retried
promotion for an already-committed key is a **no-op** (idempotent).

**Retrieve:** unchanged — fresh presigned GET at read time, tenant-scoped (E1). Fix
`generatePreSignedUrl` to return `null`/throw on failure. Drop the raw `fileUrl`/`fileKey` from
client-facing responses.

**Delete:** one tenant-scoped soft-delete-to-trash path (C2); retire the two unscoped mechanisms
(A3.3-A, A3.3-C); a scheduled purge job physically removes trashed files past a retention window. The
`DELETE temp/upload` endpoint is either wired up as the missing "cancel my in-progress upload" action or
removed.

## C4. Concurrency, idempotency, failure semantics

- **Quota (F3):** replace the live `SUM` with a single guarded
  `UPDATE company_storage SET used_size_kb = used_size_kb + :delta WHERE company_fk = :id AND
  used_size_kb + :delta <= allocated_size` — check rows-affected (0 = over quota). Atomic, no lock
  statement, and O(1) instead of a full-table scan. Symmetric decrement on delete/purge.
- **Idempotency:** an optional client-generated idempotency key per file-pick (or a short-window
  `(company, entity, record, file-hash)` fallback) so a retried upload doesn't create/bill a duplicate.
  Also fixes the mobile double-tap once the pick buttons are disabled during upload.
- **Failure semantics (commit-by-status):** partial failure leaves `PENDING`/`FAILED`, never `COMMITTED`
  with a missing object. A lightweight **scheduled sweeper** (reusing the existing `@Scheduled` pattern)
  reaps stuck/abandoned rows past a grace window and cleans half-written S3 objects. Reorder the update
  path to **upload-new → swap pointer → delete-old-after-commit** so failure always leaves the old file
  valid.

## C5. Security & isolation model

- **Every** read/delete/promote filters by the caller's resolved `companyId` through **one shared access
  helper** — the current inconsistency (some paths filter, some don't, by omission) is the root cause,
  more than any single endpoint.
- **Fail closed:** any company/record resolution failure **rejects** the operation — never proceed with a
  null company (which the current code does).
- **Content validation server-side:** extension allow-list enforced at ingestion; **content sniffing**
  (magic bytes) so a spoofed `Content-Type` can't smuggle an executable/script; **remove `image/svg+xml`**
  from the image allow-list (or sanitise + force `Content-Disposition: attachment`).
- **`@PreAuthorize`** on the temp-upload and any remaining delete routes.
- **Rate limiting** on upload/delete (the mechanism already exists in the codebase).
- **Fix the global exception handler** (rename the shadowing classes; add a real `java.lang.Exception`
  handler; assert HTTP status matches the body).

## C6. Build order & what to defer

**Build now (security/data-integrity, small blast radius):**
1. **Disable/gate the two unscoped delete endpoints** (`DELETE /files/delete/{id}`, `DELETE /files/delete`)
   — highest severity, smallest diff, do it first and independently. Add `@PreAuthorize` + company filter,
   or remove.
2. **Fix the global exception handler** (P0-1) — affects every flow.
3. **Add `company_fk` to `temporary_files`**; thread it through the delete, promotion, and generic-delete
   call sites (P0-4).
4. **Move validation into the raw-upload method** (P0-2), using the new tenant id.
5. **Remove SVG from the allow-list + add content sniffing** (stored-XSS).
6. **Atomic quota counter** (P1-5).
7. **Fix mobile:** FormData double-append, document-picker filename, error surfacing, request timeout,
   pick-button disabled guard (P1 FE).
8. **Re-enable the ticket-form link step** (A4.8 — silent data loss).
9. **Fix `generatePreSignedUrl`** fail-open string and the **mail-attachment UUID key** (P1-8, P3).

**Build soon (not urgent):** the `PENDING/COMMITTED/FAILED` status column + sweeper job; the update-path
reorder; retire `FilesHelper` (confirm zero callers + check `Files.fileData` for rows to backfill first);
migrate the remaining "parent-exists" surfaces to the one-step pattern; re-enable/decide the four
commented-out client size checks; add the missing indexes; add correlation-id/observability.

**Explicitly deferred, with the trigger that flips the call:**
- **Direct-to-S3 presigned PUT** — until backend bandwidth/hot-path cost is a measured problem (and only
  after the one-step migration builds the confirm/link endpoint it would reuse).
- **Chunked/resumable upload** — until a genuine large-file (>20MB) use case appears.
- **Async scan/transcode worker** — scope narrowly to the inbound-email path only if a virus-scan/
  transcode requirement is confirmed.
- **CDN / signed-URL caching / streaming proxy** — until a view renders hundreds of attachments per
  request (signing is local, not a bottleneck at this scale).
- **Reservation/hold quota pattern** — until overage stops being a billing correction and becomes a hard
  capacity/compliance constraint.
- **Collapsing `temporary_files` into `files`** — the tenant-column fix solves the actual defect at a
  fraction of the migration cost.

## C7. Acceptance criteria (traceable to the test set)

The feature is production-ready when every **Critical** and **High** case in `image-upload-testcases.md`
passes. The Critical gate:
- Cross-tenant read / temp-delete / link-adoption / hard-delete-by-id all **denied**
  (TC-RULE-11/12/13/16, TC-PERM-01…04).
- Unvalidated upload / spoofed MIME / script SVG all **rejected server-side** (TC-RULE-02, TC-NEG-01/02).
- Quota race **cannot overshoot** (TC-CONC-01).
- Global exception handler returns the **correct envelope + status** (TC-FAIL-09).

High gate: each surface works (TC-HAPPY-01…05), ticket-form attachments persist (TC-CROSS-03), orphans
are reaped (TC-STATE-03/TC-CROSS-02), partial-failure paths reconcile (TC-FAIL-01/02/03), mobile shows
errors + times out (TC-FAIL-04/05), S3 latency can't exhaust the pool (TC-FAIL-06), retries don't double
(TC-FAIL-07), size + quota enforced server-side (TC-RULE-04/10), email keys don't collide (TC-CROSS-04),
no null-company rows (TC-PERM-08).

## C8. Open questions (must be answered to finalise expected behaviour)

1. **Promotion mechanics** — does temp→permanent move the S3 object or re-point the key? (Untraced; blocks
   the exact behaviour of the link step and its idempotency.)
2. **Rate limiting** — is any limit in front of `/temp/upload` today?
3. **`FilesConfig` real values** — the full `validExtensions`/`maxFileSize`/`maxConsolidatedSize`/
   `maxAttachmentsAllowed` per entity/file-type.
4. **Trash retention window** — how long before a trashed file is purged? (Product/compliance decision.)
5. **SVG requirement** — is SVG genuinely needed anywhere? (Decides remove-vs-sanitise.)
6. **`Files.fileData` blob rows** — do any exist in production? (Decides whether `FilesHelper` removal
   needs a one-time backfill to S3 first.)
7. **Default quota reality** — is 1GB the shipping default for all plans, or plan-dependent?
8. **`FilesHelper` external callers** — anything outside this repo (a batch job, admin tool, sibling
   service)? Prefer a brief warn-if-invoked deprecation before hard removal.
9. **Hard-delete-by-id as admin tooling** — is any operational tool relying on it intentionally, needing a
   scoped replacement rather than a straight removal?

---

*This is the consolidated architecture of record. The current-state trace lives in `image-upload-flow.md`,
the reasoning behind the target in `image-upload-flow-review.md`, and the acceptance tests in
`image-upload-testcases.md`. When the Part C build-order lands and the Part C7 gates pass, this document's
Part A should be updated to describe the new steady state.*
