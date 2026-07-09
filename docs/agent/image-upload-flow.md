# Image / File Upload — End-to-End Flow (Detailed)

> Reference document produced by a two-sided feature deep-audit (methodology: `CLAUDE-feature-audit.md`)
> against two external repositories:
> - **Backend** — `/Users/saran/Downloads/ayphen-3.0` (Spring Boot, package `com.ayphen.api`, S3 + Postgres)
> - **Frontend** — `/Users/saran/ayphen-mobile/ayphen-frontend` (Nx monorepo: `apps/ayphen-mobile`,
>   `apps/engage-mobile`, `apps/portal`, shared `libs-mobile/*`, `libs-web/*`, `common/*`)
>
> This document is the **flow trace only** — every step of every distinct upload/retrieve/delete/edit
> path, front to back, cited `file:line`. Findings, severities, and the verdict live in the companion
> audit (see chat history / the published artifact); this file exists so the mechanics of the feature
> can be read start to finish without re-deriving them from source.

---

## Errata — corrections found by independent re-verification

This flow doc was subsequently run through four independent review lenses (Flow & Design Critic,
Decision-Making Agent, Enterprise Backend Standard checklist, Senior Backend Architect — see
`image-upload-flow-review.md`), three of which re-traced the backend source rather than trusting this
document's summary. That pass found the following corrections, which change the severity of several
points below and are recorded here so this document stays accurate:

1. **§2.1 is not the endpoint the frontend actually calls.** `POST /api/v1/files/temp/upload`
   (`FilesController.java:152-153`, no `@PreAuthorize`) resolves to
   `FilesServiceImpl.uploadToTemporaryStorage` (`FilesServiceImpl.java:832-867`) — a **separate**
   method from `processFileUpload` (§2.1 below). It takes only a raw `MultipartFile` — no
   `recordId`/`entityId`/`fileType`/`tenantId` — and **runs none of the six `CommonUtils` validation
   checks**. It writes straight to S3 and inserts a `TemporaryFile` row. Validation only happens later,
   at promotion time (`validateTempFileUploadRestrictions`, called from 6 sites in
   `FilesServiceImpl.java`), and only if the user completes the parent form save. §2.1's trace of
   `processFileUpload`/`POST /api/v1/files/upload` is accurate as written but describes an endpoint the
   frontend does not currently call.
2. **§2.5's open question is resolved: `FilesHelper` is confirmed dead code.** Every controller and
   service class in the codebase was grepped for calls to its eight exposed `FilesService` methods
   (`addFile`, `addFiles`, `updateFile(EditFilesRequest)`, `updateFiles`, `softDeleteFileById(s)`,
   `getFileByFileId`, `getFilesByFileIds`, `getFilesByEntityIdAndRecordId`) — none are called from
   anywhere reachable over HTTP. It is live, compiled, DI-wired code with zero callers today.
3. **A third delete mechanism exists**, not enumerated in §2.3: `DELETE /api/v1/files/delete` →
   `deleteFileFromTempAndMoveToTrash` (`FilesController.java:95-98`) — no `@PreAuthorize`, no tenant
   parameter, resolves a `Files` row by `fileKey` + `isActive` only, no company filter. Structurally
   identical in severity to mechanism (A) in §2.3.
4. **The application's global exception handler cannot catch real exceptions.**
   `exceptions/GlobalExceptionHandler.java` declares handlers typed `Exception`, `IOException`,
   `IllegalArgumentException`, `IllegalStateException` — but the *same package* also contains custom
   classes with those exact names (`exceptions/Exception.java`, etc.), which win Java's same-package
   name resolution over the JDK types. Confirmed by decompiling the compiled class: none of these
   handlers ever catch `java.lang.Exception`/`java.io.IOException`/etc., which is what's actually
   thrown throughout this feature (e.g. `FilesServiceImpl.java:717`, a genuine
   `java.lang.IllegalArgumentException`). This affects error handling for every flow in this document,
   not just upload.
5. **Confirmed**: the auth model on the unscoped endpoints is "any authenticated user of any tenant,"
   not literally anonymous — Spring Security's default chain requires authentication on all non-public
   routes (`CustomSecurityConfig.java:48-57`); what's missing on these routes is `@PreAuthorize`
   specifically (the tenant/permission check), not authentication itself.
6. **Confirmed**: the default company storage quota is **1GB** (`CompanyServiceImpl.java:165,467`).
   **Confirmed**: no scheduled job anywhere in the codebase reaps abandoned `TemporaryFile` rows or
   their S3 objects (only three `@Scheduled` jobs exist in the whole app, none touch files).

---

## 1. The shared pipeline, at a glance

Every surface in both apps — mobile and web — converges on the same shape:

```
┌──────────────┐    ┌──────────────────┐    ┌─────────────────────┐    ┌───────────────────┐    ┌──────────────┐
│ Pick/capture │ →  │ Upload to "temp"  │ →  │ S3 write + a         │ →  │ Link fileKey(s) to │ →  │ Retrieve via │
│ (picker/     │    │ multipart POST    │    │ TemporaryFile row    │    │ the parent record   │    │ presigned    │
│  dropzone)   │    │ v1/public/files/  │    │ (no tenant column)   │    │ on save             │    │ GET URL      │
└──────────────┘    │ temp/upload       │    └─────────────────────┘    └───────────────────┘    └──────────────┘
                     └──────────────────┘
```

There is **no presigned-PUT-from-client** anywhere in this codebase — the client always sends raw
bytes/URI through the backend, and the backend owns the S3 write. Presigned URLs only ever appear on
the **read** side. The two ticket-attachment endpoints are the one exception to the generic
temp-upload-then-link pattern — they upload directly against the ticket entity in one step (see §3.7).

---

## 2. Backend flows — `ayphen-3.0`

All citations are `file:line` under
`/Users/saran/Downloads/ayphen-3.0/src/main/java/com/ayphen/api/` unless stated otherwise.

### 2.1 Upload — `POST /api/v1/files/upload`

`FilesController.java:43-54` → `FilesServiceImpl.processFileUpload`, `FilesServiceImpl.java:634-688`.

1. **Controller receives** the multipart file plus `recordId`, `entityId`, `fileType`, `description`,
   `tenantId` (`FilesController.java:43-54`). This endpoint carries **no `@PreAuthorize`** — a
   deliberate contrast with the tenant-scoped `/tenant/{tenantId}/...` routes, which do.
2. **Resolve the owning `Entities` row** and build the S3 key:
   `{companyGuuid}/entities/{entityName}/{recordId}/{UUID}/{originalFilename}`
   (`FilesServiceImpl.java:641-649`). The client-supplied filename is embedded **raw** — no
   sanitization.
3. **Resolve `Company`** by guuid — optional; the code silently proceeds with a `null` company if the
   guuid isn't found or wasn't supplied.
4. **Validate** — `commonUtils.validateFileUploadRestrictions(...)` (`FilesServiceImpl.java:661-662`):
   - Look up `FilesConfig` for the `(entityId, fileTypeId)` pair — throws if missing.
   - If `companyId != null`, check the **company storage quota**: `CompanyStorageAllocation.allocatedSize`
     vs. a **live** `SUM(fileSizeKb)` computed by `filesRepository.calculateTotalUsedStorageByCompany`.
     This is a **plain read** — no `SELECT ... FOR UPDATE`, no lock, no trigger.
   - Check the **per-file size** against `FilesConfig.maxFileSize`.
   - Check the **consolidated size** for this record+type against `FilesConfig.maxConsolidatedSize`.
   - Check the **extension** against `FilesConfig.validExtensions` (a comma-separated allowlist,
     case-insensitive).
   - Check the **attachment count** for this record against `FilesConfig.maxAttachmentsAllowed`.
5. **Write to S3** — `uploadToS3(...)`, a single `PutObjectRequest` with `ACL.PRIVATE`
   (`FilesServiceImpl.java:665, 881-891`).
6. **Persist the `Files` row** (`FilesServiceImpl.java:671, 684`) — `fileUrl` is set to the **raw,
   non-presigned** S3 URL via `s3Client.utilities().getUrl(...)`.
7. **Respond** with a `FilesDTO` (`ConversionUtils.convertToFilesDTO`) containing **both** the raw
   `fileUrl`/`fileKey` **and** a freshly generated presigned URL (`ConversionUtils.java:1264,1267,1270`).

**Ordering and failure behavior**: steps 5 and 6 are both inside one class-level
`@Transactional(rollbackOn = Exception.class)` (`FilesServiceImpl.java:55`). The **S3 write happens
before the DB insert**. If the `save()` in step 6 throws after the `putObject` in step 5 already
succeeded, the DB transaction rolls back the `Files` row — but the S3 object is **never removed**.
There is no reconciliation job anywhere in the codebase that later detects or cleans this up. There is
no equivalent failure mode on this path in the other direction (a DB row pointing at a missing S3
object), because the S3 write always happens first here.

### 2.2 Retrieve

- `getFilesByRecordId`, `getFileByGuuid`, `getFilesByCompanyIdAndFileType` all return
  `FilesDTO`/`Page<FilesDTO>` containing a presigned URL generated **at conversion time**, not stored —
  `ConversionUtils.generatePreSignedUrl` (35-minute expiry, `ConversionUtils.java:1211,1223`).
- There is **no backend byte-streaming/proxy endpoint** — nothing in `FilesController` streams S3 bytes
  directly to the caller. (`getInputStream`, `FilesServiceImpl.java:1413`, is internal-only, used to
  build PDFs.)
- Every retrieval path traced is tenant-scoped by `companyId` —
  `getFileByGuuid` → `findByCompanyIdAndGuuidAndIsActiveTrue` (`FilesServiceImpl.java:2449`);
  `getFilesByCompanyIdAndFileType` additionally filters by the caller's accessible location IDs
  (`FilesServiceImpl.java:580-605`) — **except** the `FilesHelper` path (§2.5) and the raw-`fileUrl`
  field riding alongside every response (§2.1 step 7).
- `generatePreSignedUrl` swallows `SdkClientException` and returns the **literal string**
  `"Error generating pre-signed URL"` instead of `null` or rethrowing (`ConversionUtils.java:1223-1227`)
  — a caller that doesn't validate the URL shape silently gets a broken link rendered as if it were
  real.

### 2.3 Delete — two mechanisms coexist

**(A) Hard delete by numeric id.**
`FilesController.deleteFile(Long id)` (`FilesController.java:90-93`, no `@PreAuthorize`) →
`FilesServiceImpl.deleteFile(Long id)` (`FilesServiceImpl.java:468-487`):
1. Look up the `Files` row by id via `findByIdAndIsActiveTrue(id)` — **no company/tenant filter at
   all**.
2. Delete the S3 object.
3. Set `isActive = false`.

Any authenticated caller of any tenant who can guess/enumerate a sequential numeric id can permanently
delete another company's file — the S3 object is actually deleted (not trashed), so there is no
recovery path.

**(B) Tenant-scoped soft-delete-to-trash by key.**
`FilesController.deleteFile(UUID tenantId, FileDeleteRequest)` (`FilesController.java:174` region) →
`FilesServiceImpl.deleteFile(UUID tenantId, List<String> fileKeys)` (`FilesServiceImpl.java:2120-2216`):
1. Resolve `companyId` once from `tenantId`.
2. For each key, branch on whether it belongs to a **permanent `Files` row** or a **`TemporaryFile`
   row**.
   - Permanent rows: both `handlePermanentDelete`/`handleSoftDelete` filter by `fileKey AND companyId`
     (`:2163, 2195`) — correctly scoped.
   - Temp rows: `findByFileKey` (`:2172`, no `isActive`/company filter at all) and
     `findByFileKeyAndIsActiveTrue` (`:2216`, still no company filter) — because `temporary_files` has
     **no company column in the schema**, this is a structural gap, not a missed `WHERE` clause. Any
     authenticated caller who knows or guesses another tenant's temp `fileKey` can hard-delete their
     staged file and its S3 object.
3. `restoreFile` (`FilesServiceImpl.java:2284-2329`) is correctly tenant-scoped
   (`findByFileKeyAndCompanyIdAndIsActiveFalse`, `:2292`) and only ever operates on the permanent table.
4. The trash-move itself (`moveFileInS3`/`moveFileToTrashInS3`, `:922-936, 1743`) is copy-then-delete
   with no rollback if the delete-of-the-original fails after the copy succeeds — leaves a duplicate
   object in both the trash location and the original location (self-healing on a successful retry).

### 2.4 Edit / update

`updateFile(id, newFile, companyGuuid)` → `processFileUpdate` (`FilesServiceImpl.java:704-753`):
1. Delete the **old** S3 object (`:720`).
2. Upload the **new** file (`:727`).
3. Update the `Files` row's metadata to point at the new key/url.

If step 2 fails after step 1 already succeeded, the `Files` row is left **active** but pointing at an
S3 key that no longer exists — a genuine dangling reference, worse than the create-path orphan (§2.1),
because here the row still looks healthy to every caller until someone actually tries to fetch the
file.

`editFileMetadata` (`FilesServiceImpl.java:2364-2388`) only touches record/link association metadata
(e.g., transaction or location linkage) and is correctly tenant- and existence-checked.

### 2.5 Second upload path — `FilesHelper` (DB-blob storage, bypasses S3)

`utility/helper/FilesHelper.java` implements a **complete second pipeline**:
`addFile`/`addFiles`/`updateFile`/`updateFiles`/`softDeleteFileById(s)`/`getFileByFileId`/
`getFilesByFileIds`/`getFilesByEntityIdAndRecordId`, storing raw bytes directly into `Files.fileData`
(`FilesHelper.java:75`).

1. Incoming bytes are written straight into the `Files.fileData` BLOB column — **no S3 interaction**.
2. Validation is limited to a non-null/non-empty check (`:246, 257`) — **none** of the six
   `CommonUtils` rules from §2.1 step 4 are invoked anywhere in this class.
3. Every lookup (`findByIdAndIsActiveTrue`, etc.) operates on a bare numeric `fileId` with **no
   companyId filter anywhere in the class**.

`FilesService` (the interface) exposes these exact method names (`service/FilesService.java:38, 47, 56,
65, 73, 81`) as a distinct contract alongside the S3-based `uploadFile`/`updateFile(Long,...)` methods —
confirming this is a live, callable second code path rather than dead code. Which controller(s)
actually invoke it was **not traced** in this pass (see the audit's open questions).

### 2.6 Mail attachments

`FilesController.uploadMailAttachments` (`:172-182`) → `FilesServiceImpl.uploadMailAttachments`
(`:1926-2037`):

1. Reuses the general validation pipeline — `commonUtils.validateTempFileUploadRestrictions`
   (`:1986-1994`) — with `fileTypeId = LK_FILE_TYPE_UN_CATEGORISED_DOC`.
2. Iterates the batch of attachments; **per-file exceptions are caught and logged to `MailAudit`**
   rather than aborting the whole batch — an intentional partial-success design, not a bug.
3. The S3 key for this path is built **without** a `UUID.randomUUID()` segment (`:2000`):
   `{companyGuuid}/entities/{entityName}/UnCategorisedDocs/{originalFilename}` — fully deterministic
   and collision-prone, unlike every other upload path in the codebase. Two mail attachments with the
   same filename silently overwrite each other in S3.

**Inbound email attachments** (`EmailReaderService.java`, pulling from MS Graph API) reuse this exact
pipeline by wrapping raw `byte[]` content in `config/ByteArrayMultipartFile.java` (only call site:
`EmailReaderService.java:441`) — meaning externally-supplied, attacker-controlled filenames/content
from arbitrary email senders flow through the identical S3-key-construction and
content-type-trusting logic as a browser upload.

---

## 3. Frontend flows — `ayphen-frontend`

All citations are relative to `/Users/saran/ayphen-mobile/ayphen-frontend/` unless stated otherwise.

### 3.1 Mobile — Dashboard "Upload Document" (docket/receipt), `apps/ayphen-mobile`

This is the **one real, wired-up** image/file upload flow on mobile.

1. User opens the `UploadDocket` modal
   (`apps/ayphen-mobile/src/pages/dashboard/upload-documents/form/index.tsx:72-136`).
2. **"Pick a File"** → `pickDocument` (`src/utils/attachment/hooks.tsx:22-40`):
   `DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true })` — a system picker, no
   permission prompt needed, and **no file-type restriction** — it accepts literally anything.
3. **"Pick from Gallery"** → `pickImage` (`hooks.tsx:42-60`): explicitly calls
   `ImagePicker.requestMediaLibraryPermissionsAsync()` (`:43`); on denial, shows
   `Alert.alert("Permission to access gallery is required!")` (`:45`) and stops. On grant:
   `launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.2 })` — the **only** compression is
   the `0.2` JPEG-quality knob; no `expo-image-manipulator`, no dimension resize.
4. Either path calls `uploadFileTos3` (`hooks.tsx:62-87`), which dispatches the `uploadFileMobile`
   Redux thunk with `{ uri, name, type }`.
   - **Known bug on the document-picker path**: `hooks.tsx:36` calls
     `uploadFileTos3({ ...file, fileName: file })` — `file` is the whole
     `DocumentPickerAsset` object, not its `.name` string. `fileName` therefore becomes a stringified
     object rather than the real filename. The gallery-picker path (`hooks.tsx:54-57`) does not have
     this bug — it passes the picker asset straight through, and `ImagePicker` assets carry a native
     `.fileName` field.
5. Inside the shared thunk machinery, `generateAsyncThunkForMultipartUri`
   (`common/api-manager/src/lib/api-handler.ts:262-299`) builds the `FormData`:
   ```ts
   const formData = new FormData();
   if (props.file) {
     formData.append("file", props.file.name);                 // ← bug: bare string, wrong part
     formData.append("file", {                                  // ← the real RN file part
       uri: props.file.uri,
       name: props.file.name || "upload.jpg",
       type: props.file.type || "application/octet-stream",
     } as any);
   }
   ```
   Key `"file"` is appended **twice** — once as a bare filename string, once as the actual React
   Native file object. The sibling web method, `generateAsyncThunkForMultipart` (`:222-260`), does a
   single correct `formData.append("file", props.file)` (`:229`) — confirming this is a mobile-only
   defect, not an intentional multi-part convention.
6. The request posts to `v1/public/files/temp/upload` (`common/api-manager/src/lib/file-doc-handler/
   api-data.ts:3-6`) through the shared `API` axios instance — which has both the auth interceptor
   (`apps/ayphen-mobile/src/utils/api-interceptor.ts:8-17`, attaching `Authorization: Bearer <token>`)
   and **no configured request timeout** anywhere in this call path.
7. **On success**: `setAttachments(prev => [...prev, response.body])` and
   `Alert.alert("File uploaded successfully")` (`hooks.tsx:79-83`). The response `body` is the backend's
   `FilesDTO`/`UploadFileModel` shape from §2.1 step 7 — `fileKey`, `fileUrl`, `preSignedUrl`,
   `mimeType`, etc.
8. **On failure**: `.catch(err => console.log(err))` (`hooks.tsx:84-86`) — nothing is shown to the user.
   No retry, no offline queue.
9. **Delete** — `onDeleteAttachment` (`hooks.tsx:89-102`) is **local-only**: it removes the item from
   the in-memory `attachments` array and stages it in a parallel `deletedAttachments` array. It never
   calls the backend's `DELETE /v1/public/files/temp/upload` endpoint (§3-contract table) — so a temp
   file the user "removes" before saving the form stays orphaned in the backend/S3 with no cleanup
   trigger from this flow.
10. **On form Save** — `gerenareRequestData()` (`hooks.tsx:104-129`, note the typo in the function
    name) flattens both arrays into `{ create: { fileKey: [...] }, delete: { fileKey: [...] } }`, which
    becomes part of the parent entity's save payload. This is the "link" half of the
    upload-then-link pattern every surface in this codebase uses.
11. **No concurrency guard** — neither "Pick a File" nor "Pick from Gallery" is `disabled` while an
    upload is in flight (`form/index.tsx:104-121`), unlike the equivalent web widget (§3.4) — a
    double-tap fires two concurrent `uploadFileMobile` dispatches, appending duplicate attachments.

### 3.2 Mobile — `ImagePickerComponent` shared library (dead code path)

`libs-mobile/mobile-components/src/lib/ImagePicker/index.tsx:27-40`, exported at
`libs-mobile/mobile-components/src/index.ts:28`.

1. Implements its own `pickImage`:
   `launchImageLibraryAsync({ quality: 1, allowsEditing: true, aspect: [4, 3] })`.
2. **No permission-denial handling at all** — relies implicitly on the OS-level prompt, with no
   explicit `requestMediaLibraryPermissionsAsync()` call and no branch for a denied result.
3. **No upload call** — it only returns the local picked URI via an `onImageSelected` callback; the
   caller is expected to do something with it.
4. Grep across both `apps/ayphen-mobile` and `apps/engage-mobile` found **zero consumers** of this
   component. It is inert today, and — since its `quality: 1` (no compression) diverges from the real
   flow's `quality: 0.2` (§3.1 step 3) — it is also a second, inconsistent implementation of "pick an
   image" rather than a shared source of truth.

### 3.3 `engage-mobile` — Attachments (non-functional)

`apps/engage-mobile/src/app/pages/projects/project-detail/overview/index.tsx:250-266` renders a static
"Attachments" section using a `NoDataContainer description="No attachments found"` placeholder.

- No picker call, no upload thunk dispatch, no state wiring of any kind exists in this app.
- `expo-image-picker` is listed in `apps/engage-mobile/package.json` but is never imported anywhere
  under `apps/engage-mobile/src` (confirmed by grep) — a dependency with no consumer.

### 3.4 Web — Generic multi-file `Attachments` widget

`apps/portal/src/components/Attachments/index.tsx` (+ `utils.ts`, `hooks.ts`, `AttachmentsListView.tsx`).

1. Rendered inside a domain form (e.g. `UploadDocket.tsx`, the ticket form, company attachments) —
   `Attachments/index.tsx:131-204`.
2. User drops/selects file(s) into an antd `Upload` control (`:155-183`).
3. `beforeUpload` → `beforeUploadAttachment` (`Attachments/utils.ts:37-84`):
   - Check total count vs. `maxAttachments` (default 10, `:64` / `index.tsx:157`) — `:45-55`.
   - Check file type against an allow-list (images + PDF + Office + CSV, see `:122-148`) — `:58-68`.
   - **File-size check is present in source but fully commented out** — `:70-80`.
4. `customRequest` → `customAttachmentRequest` (`utils.ts:86-120`):
   - Sets `attachmentUploading.setValue(true)` (`index.tsx:175`).
   - Dispatches the `uploadFile` thunk with `{ file }`, `await`s `.unwrap()`.
   - This routes through `generateAsyncThunkForMultipart` (`api-handler.ts:222-260`) — the **correct**
     single-append version of the FormData builder (contrast §3.1 step 5).
5. **On success**: `onSuccess` callback, `attachmentData.setValue(prev => [...prev, response.body])`,
   and a success `notification` (`:104-109`).
6. **On failure**: `onError` callback, an error `notification` reading
   `err?.body?.join(" ") || err?.message` (`:111-119`) — **is** surfaced to the user, unlike the mobile
   flow.
7. `finally` clears `attachmentUploading` (`:180-182`), which drives `disabled`/`loading` on both the
   `Upload` control and the "Add" button (`:159-163, 186-193`) — a real double-submit guard.
8. **Delete** — `onDelete` (`:70-75`) is local-only, staging the item into `deletedValues`; the actual
   backend delete (if it ever happens) only occurs via the parent entity's save payload carrying
   `delete.fileKey` — same orphaning risk as the mobile flow if the user abandons the form before
   saving.

### 3.5 Web — Single-file `UploadAttachment` dropzone

`apps/portal/src/components/UploadAttachment/index.tsx:61-120` (+ `utils.ts`, `style.tsx`).

Same shape as §3.4 but constrained to a single file:
1. Type allow-list checked in `beforeUpload` (`:95-99`).
2. **Size check also present but commented out** (`:107-117`).
3. Double-submit guard present, but reads the **global** `fileServiceSlice.uploadFileState` rather than
   a component-local flag — `disabled={uploadFileState.isLoading || isDisabled}` (`:125`). Because this
   slice is shared app-wide (`common/state-manager/src/lib/shared-slice/file-doc-handler/slice.ts:10-25`),
   an unrelated upload widget on the same screen dispatching `uploadFile` concurrently can flip this
   same `isLoading` flag.

### 3.6 Web — Profile image / Company logo

`apps/portal/src/components/ProfileImage/index.tsx` (+ `style.tsx`, `hooks.tsx`, `utils.ts`).

1. Renders an antd `Upload` wrapped in `ImgCrop` (`antd-img-crop`), so the user crops/rotates the image
   before the blob is finalized.
2. `beforeUpload` validates `isImage`/`isJpgOrPng` (jpg/jpeg/png only) **and** an *active*
   `isLt1M` (< 1MB) size check — the only surface in the entire audit where the size check is not
   disabled.
3. On crop confirm, dispatches `uploadFile` (the same generic thunk as §3.4/3.5).
4. **On success**: sets local `logo` state, shows a success `message`.
5. **On failure**: shows `err?.body?.join(" ") || err?.message`.
6. This is **local-state only** — the picked logo is not attached to the user/company record until the
   parent form saves. On save, `logoRequestData(logo, deletedLogos)` feeds `bodyParam.files.logo` into
   the entity's PATCH/POST call — the same generic upload-then-link-by-`fileKey` pattern as everywhere
   else in this codebase.
7. **No `disabled` guard** on the `Upload` control itself during upload — only a `Spin` overlay driven
   by `isLogoUploading` — so a very fast double-click before the overlay renders could, in principle,
   fire twice.
8. Company logo (`apps/portal/src/pages/company/components/general-form.tsx`) reuses this **exact**
   component and its `useLogo` hook — there is no separate company-logo implementation.

### 3.7 Web — Ticket attachments (post-creation, working)

`apps/portal/src/tickets/tickets/ticket-details/ticket-attachments.tsx:151-184`.

1. `customRequest` dispatches a **dedicated** thunk, `addTicketAttachment`, directly with the raw
   `file: Blob` and `pathParam: { tenantId, public: appCode, id: ticketId }`.
2. Hits `v1/public/{tenantId}/tickets/{id}/attachments`
   (`common/api-manager/src/lib/tickets/api-data.ts:79-85`) — a **one-step** upload tied straight to
   the ticket entity, unlike the generic upload-then-link pattern used everywhere else.
3. `uploading` state disables the control during upload.
4. **Delete** is fully wired: a `Popconfirm` confirms, then `deleteTicketAttachment` calls
   `v1/public/{tenantId}/tickets/attachments/{id}` (`tickets/api-data.ts:87`) — a real backend delete,
   unlike every "local-only" delete in the other flows.

### 3.8 Web — Ticket attachments (create/edit form, broken)

`apps/portal/src/tickets/tickets/ticket-form/ticket-form-hooks.tsx`.

1. The generic `Attachments` widget (§3.4) is rendered inside the ticket create/edit form.
2. Individual files **are** uploaded to the generic `uploadFile` endpoint as the user picks them,
   successfully receiving real `fileKey`s back — the user sees the attachment appear in the list with a
   success notification, identical to §3.4.
3. In both `onCreateTicket` and `onEditTicket`, the line that would attach those collected `fileKey`s to
   the outgoing request body is **commented out**:
   ```ts
   // files: {
   //   logo: logoRequestData(projectLogo.logo, projectLogo.deletedLogos),
   //   attachments: attachmentRequestData(
   //     attachments.value,
   //     attachments.deletedValues
   //   ),
   // },
   ```
4. **Net effect**: files the user selects while creating or editing a ticket are uploaded successfully,
   shown as attached in the UI — and then silently dropped. They exist as orphaned temp uploads on the
   backend (§2.1/§2.5's `temporary_files` table) but are never linked to the ticket, and the user has no
   indication anything went wrong.

### 3.9 Web — Docket/receipt upload (Books)

`apps/portal/src/books/UncategorizedDockets/UploadDocket.tsx`.

1. Embeds the generic `Attachments` widget (§3.4), configured with
   `allowedFileTypesForUncategorised` — PDF/JPG/PNG/XLS/XLSX/CSV/DOC/DOCX/PPT/PPTX.
2. On Save, the collected `fileKey`s are POSTed as JSON (not multipart — the files are already
   uploaded) to a **dedicated domain endpoint**:
   `v1/public/files/tenant/{tenantId}/upload-uncategorized`
   (`common/api-manager/src/lib/uncategorized-documents/api-data.ts:11-14`).
3. A loading guard is wired via `okButtonProps={{ loading: ... }}`.
4. **Separately**, `apps/portal/src/books/UncategorizedDockets/DeletedDocketsList.tsx`'s
   "permanently delete" confirmation handler has its **entire body commented out** — the `deleteDocs`
   dispatch, the success/error notification, and the refetch are all dead — so clicking "confirm" on a
   permanent delete does nothing. Only the separate, working "restore" action functions on this screen.

### 3.10 Web — `UploadUncategorizedDockets/DocketsList.tsx` (not actually an upload surface)

Included in the original file survey because it matched an "upload" keyword grep, but on inspection:
this is a **read-only picker drawer** that GETs already-uploaded uncategorized documents and lets the
user attach one of the *existing* ones to another record. There is no file input, no validation step,
and no delete action here. It links via the record's `preSignedUrl` directly, with no expiry/refresh
handling if that URL has already lapsed by the time the user acts on it.

### 3.11 Web — Bank statement / Supplier price file uploads

`apps/portal/src/books/Accounting/Reconciliation/UploadBankStatement/index.tsx` and
`apps/portal/src/books/Purchase/Suppliers/SupplierDetails/UploadPriceFile/index.tsx`.

Both are dedicated "upload + server-side parse preview" flows (`bank-payments/upload-preview`,
`price-files/parse-preview`), restricted to XLS/XLSX/CSV — **not image-relevant**. Included here only
because they share the exact same `beforeUpload`-with-size-check-commented-out pattern seen in §3.4/3.5,
confirming that pattern is systemic across the upload component family rather than local to attachments.

---

## 4. Contract summary — every endpoint touched by the flows above

| Endpoint | Method | Called by | Defined at |
|---|---|---|---|
| `v1/public/files/temp/upload` | POST | §3.1, §3.4, §3.5, §3.6, §3.8, §3.9 (initial per-file upload) | `common/api-manager/src/lib/file-doc-handler/api-data.ts:3-6` |
| `v1/public/files/temp/upload` | DELETE | **Nobody** — defined, zero call sites in the repo | `file-doc-handler/api-data.ts:8-11` |
| `v1/public/files/tenant/{tenantId}/upload-uncategorized` | POST | §3.9 (link step) | `uncategorized-documents/api-data.ts:11-14` |
| `v1/public/files/files/{tenantId}/{fileTypeId}` | GET | §3.10 (list existing docs to attach) | uncategorized-documents area |
| `v1/public/{tenantId}/tickets/{id}/attachments` | POST | §3.7 (one-step ticket upload) | `common/api-manager/src/lib/tickets/api-data.ts:79-85` |
| `v1/public/{tenantId}/tickets/attachments/{id}` | DELETE | §3.7 (ticket attachment delete — the one flow with a real backend delete) | `tickets/api-data.ts:87` |
| `POST /api/v1/files/upload` | POST | Backend-side entry point that `v1/public/files/temp/upload` ultimately resolves to (§2.1) | `FilesController.java:43` |
| `DELETE /api/v1/files/delete/{id}` | DELETE | Backend hard-delete-by-id (§2.3-A) — no known frontend caller, reachable directly via API | `FilesController.java:90-93` |
| `/tenant/{tenantId}/...` (delete/restore/edit/mail-attachment/statement) | various | Backend tenant-scoped routes (§2.3-B, §2.4, §2.6) | `FilesController.java:143,174,192,209,220,247,259` |

---

## 5. One upload followed start to finish (worked example: mobile docket photo)

To make the cross-repo handoff concrete, here is a single upload traced through every layer, using the
mobile docket-photo flow (§3.1) as the example:

1. **User action** — taps "Pick from Gallery" in the `UploadDocket` modal.
2. **Permission** — `ImagePicker.requestMediaLibraryPermissionsAsync()` resolves granted.
3. **Capture** — `launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.2 })` returns a local
   asset `{ uri, fileName, ... }`.
4. **Client-side transform** — none beyond the `0.2` JPEG re-encode baked into the picker call itself;
   no resize, no explicit compression step.
5. **Dispatch** — `uploadFileTos3` fires the `uploadFileMobile` Redux thunk with `{ uri, name, type }`.
6. **Request construction** — `generateAsyncThunkForMultipartUri` builds a `FormData`, appending to key
   `"file"` twice (bug, §3.1 step 5) — once as a string, once as the real RN file part.
7. **Transport** — POST to `v1/public/files/temp/upload` via the shared `API` axios instance, bearer
   token attached by the mobile interceptor, no client-side timeout configured.
8. **Backend entry** — `FilesController`'s upload endpoint receives the multipart body (no
   `@PreAuthorize`), resolves the owning entity and (optional) company.
9. **Backend validation** — `CommonUtils.validateFileUploadRestrictions` runs the six checks from §2.1
   step 4 against the DB-seeded `FilesConfig` row for this entity/file-type — size, consolidated size,
   extension, count, and (if a company was resolved) the live-SUM quota check with no locking.
10. **S3 write** — `PutObjectRequest` with `ACL.PRIVATE`, keyed
    `{companyGuuid}/entities/{entityName}/{recordId}/{UUID}/{filename}`.
11. **DB write** — a new `files` row is inserted, `fileUrl` set to the raw (non-presigned) S3 URL.
12. **Response** — `FilesDTO` returned containing `fileKey`, the raw `fileUrl`, `mimeType`, and a
    presigned `preSignedUrl` valid for 35 minutes.
13. **Client receives** — `response.body` is pushed into the mobile screen's local `attachments` array;
    `Alert.alert("File uploaded successfully")` fires.
14. **User saves the parent docket form** — `gerenareRequestData()` flattens `attachments` into
    `{ create: { fileKey: [ "<the key from step 12>" ] } }`, sent as part of the docket's save payload.
15. **Backend link step** — (traced separately per domain; for dockets this is the
    `upload-uncategorized` endpoint pattern from §3.9/§4) the `fileKey` is used to look up the
    still-`TemporaryFile`-backed row and associate/promote it to the permanent record. **This exact
    promotion mechanism — how a `TemporaryFile` row becomes a permanent, entity-linked `files` row — was
    not directly traced in either audit pass and is the single open question that would complete this
    end-to-end picture.**
16. **Later retrieval** — any screen displaying this docket calls a `getFilesBy...` method, which
    generates a **fresh** presigned URL at read time (§2.2) — the URL returned in step 12 is not the one
    ultimately used for display; it was only ever valid for 35 minutes from that moment.

---

## 6. Where flows diverge or duplicate (a map, not a verdict)

- **Two mobile "pick an image" implementations** exist with no shared lineage: the real one in
  `apps/ayphen-mobile/src/utils/attachment/hooks.tsx` (`quality: 0.2`, explicit permission handling,
  wired to upload) and the unused one in `libs-mobile/mobile-components/src/lib/ImagePicker`
  (`quality: 1`, no permission handling, no upload call). Neither is a superset of the other.
- **`attachmentRequestData`/`gerenareRequestData`-style flattening logic** is implemented nearly
  identically in `apps/ayphen-mobile/src/utils/attachment/util.ts:3-31` and
  `apps/portal/src/components/Attachments/utils.ts:7-35` — copy-pasted rather than shared via
  `common/`.
- **The size-check-present-but-commented-out pattern** recurs verbatim across at least four separate
  files (`UploadAttachment/index.tsx`, `Attachments/utils.ts`, the bank-statement uploader, the
  price-file uploader) — one copy-paste origin, not four independent decisions.
- **Delete semantics differ by surface**: ticket attachments (§3.7) delete for real against the backend;
  every other surface's "delete" (§3.1, §3.4, §3.5, §3.6) is local-state-only until the parent form
  saves, and even then only communicates a `delete.fileKey` list — it never calls
  `DELETE v1/public/files/temp/upload` (§4), which has zero callers anywhere in the repo.
- **Two upload-completion models**: the generic temp-upload-then-link pattern (§3.1, §3.4–§3.6, §3.9)
  vs. the direct one-step entity-attached upload used only by ticket attachments (§3.7). The ticket
  create/edit form (§3.8) tries to use the generic pattern but never completes the "link" half — a
  concrete case of the two models being mixed within a single feature.
- **Backend has two independent upload/storage pipelines**: the hardened S3 path (§2.1–§2.4, §2.6) and
  the DB-blob `FilesHelper` path (§2.5), sharing the same `Files` table and the same `FilesService`
  interface but with materially different validation and tenant-scoping guarantees.

---

*End of flow trace. Findings, severities, remediation order, and the verdict for both repositories are
covered in the companion audit (see conversation history or the published artifact
`image-upload-audit.html`).*
