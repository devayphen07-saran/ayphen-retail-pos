# Image / File Upload — Test Cases & Edge-Case Scenarios

> Produced with the **Business Analyst + QA** methodology (`CLAUDE-ba-qa-testcases.md`), grounded in:
> - `image-upload-flow.md` — the end-to-end flow trace (backend `ayphen-3.0`, frontend `ayphen-frontend`).
> - `image-upload-flow-review.md` — the four-lens review (Critic / Decision / Backend-Standard / Architect).
>
> Every test case traces to a **requirement (R#)**, a **business rule (BR#)**, or a **known finding
> (F#)** from those documents, so coverage is provable and gaps are visible. Where a case verifies a
> *defect*, its expected result is written **two ways**: the current (broken) behaviour and the
> **correct behaviour it must have after the fix** — so the same case doubles as the acceptance test
> for the remediation.
>
> **Scope caveat carried from the review:** the *actual* frontend upload endpoint is
> `POST /api/v1/files/temp/upload` → `uploadToTemporaryStorage`, which today runs **no validation** and
> has **no tenant column**. Many cases below fail on the current build by design — that's the point.
> Cases are marked `[FAILS TODAY]` where the current implementation does not meet the expected result.

---

## 1. Feature understanding (BA)

**What the feature does.** A user picks or captures a file (image, PDF, Office doc, CSV) on a client
(two Expo mobile apps, one React web portal) and attaches it to a business record — a docket/receipt,
a ticket, a customer/supplier/employee/company logo, a bank statement, a supplier price file. The
client uploads raw bytes through the Spring Boot backend, which writes to S3 (`ACL.PRIVATE`) and stages
a `TemporaryFile` row; on saving the parent record, the collected `fileKey`s are linked (promoted) into
the tenant-scoped `Files` table. Retrieval is always via a freshly-generated presigned GET URL (35-min
expiry). Inbound email attachments enter the same pipeline.

**Actors.**
- **Authenticated tenant user** (web portal / mobile app) — picks, uploads, links, views, deletes files.
- **Inbound email sender** (external, untrusted) — attachments ingested via MS Graph API into the same
  pipeline.
- **The system / scheduled jobs** — (today: none reap orphans; a reaper is a proposed remediation).
- **A second tenant's user** — the adversary in every tenant-isolation case.

**Inputs / outputs.**
- Input: a multipart file (bytes + client-declared filename + client-declared MIME type), plus, on the
  *validated* backend endpoint, `recordId`/`entityId`/`fileType`/`tenantId`.
- Output: an `ApiResponse` envelope whose `body` carries `fileKey`, `fileUrl` (raw S3 URL), a presigned
  `preSignedUrl`, `mimeType`, `fileSizeKb`.

**Requirements (R).**
- **R1** — a user can upload a file from every supported surface and see it attached to the record.
- **R2** — a user can view/download an attached file via a working, time-limited URL.
- **R3** — a user can remove an attached file (before and after the parent record is saved).
- **R4** — a user can replace/update an existing attached file.
- **R5** — inbound email attachments are stored against the correct company.
- **R6** — abandoned/unlinked uploads do not accumulate forever.

**Business rules (BR) — from the flow doc's validation set (`validateFileUploadRestrictions`) and the
frontend guards.**
- **BR1 (file type)** — only allowed extensions/MIME types per `FilesConfig.validExtensions`
  (server-side) and the surface's client allow-list (jpg/png for logos; images+PDF+Office+CSV for
  generic attachments).
- **BR2 (per-file size)** — a file may not exceed `FilesConfig.maxFileSize` (server), or the client cap
  (1MB for logos; 5MB intended-but-commented-out for attachments; 20MB Spring blanket cap as the only
  live backend ceiling on the temp endpoint).
- **BR3 (consolidated size)** — total size for a `(record, fileType)` may not exceed
  `FilesConfig.maxConsolidatedSize`.
- **BR4 (attachment count)** — a record may not exceed `FilesConfig.maxAttachmentsAllowed` (generic
  widget default 10; ticket post-creation 1).
- **BR5 (company storage quota)** — a company's total file storage may not exceed
  `CompanyStorageAllocation.allocatedSize` (default **1GB**).
- **BR6 (tenant isolation)** — a user may only read/link/delete/restore files belonging to their own
  company. **No cross-tenant access, ever.**
- **BR7 (private storage)** — objects are never public; every read is a fresh, expiring presigned URL.
- **BR8 (soft-delete + restore)** — a delete moves a permanent file to trash (recoverable); restore
  brings it back. Permanent deletion is a distinct, deliberate action.

**Acceptance criteria (the "genuinely production-ready" bar).** Every BR is enforced **satisfied AND
violated** at a level that can't be bypassed by a direct API caller (server-side, not just client-side);
every partial-failure path leaves no orphan or dangling reference; concurrency on the quota can't
overshoot; no cross-tenant read/write/delete is possible on any endpoint including the temp table.

**State machine (a file's lifecycle).**
```
        (upload)              (link on save)            (delete)            (restore)
[none] ─────────► [TEMP / staged] ─────────► [PERMANENT / active] ─────────► [TRASHED] ──────► [PERMANENT / active]
                       │                              │  ▲                        │
                       │ (abandoned:                  │  │ (update: replace bytes) │ (permanent delete)
                       │  never linked)               │  └────────┘                ▼
                       ▼                                                        [PURGED / gone]
                  [ORPHAN — no reaper today]
```
Legal transitions: none→temp, temp→permanent, permanent→trashed, trashed→permanent, trashed→purged,
permanent→(replace)→permanent. Illegal transitions to reject: restore a permanent (non-trashed) file;
link an already-linked/purged key; delete an already-trashed file twice; act on another tenant's file in
any state.

**Assumptions / ambiguities flagged.**
- The exact temp→permanent promotion SQL/S3 behaviour was not traced end to end (flow doc §5 step 15 open
  question) — cases that depend on it (TC-STATE-02, TC-CONC-03) state the assumption they test under.
- Whether a rate limit exists in front of the temp endpoint is unconfirmed (review §1 open question) —
  TC-NEG-08 tests the intended behaviour.
- The default `FilesConfig` extension/size rows were only sampled, not fully dumped — BR1/BR2 satisfied
  cases use the sampled values; confirm against the real config table before finalising expected results.

---

## 2. Coverage plan

| Dimension (§4 of the methodology) | Applies? | Approx. cases | Focus |
|---|---|---|---|
| Happy paths | Yes | 8 | one per upload surface + view + delete + restore |
| Business rules (satisfied + violated) | Yes | 16 | BR1–BR8, each way |
| Boundaries | Yes | 10 | size/count/quota at limit ±1, empty, max, filename length |
| Negative / invalid | Yes | 10 | wrong type, spoofed MIME, malformed multipart, injection, forbidden action |
| Failure & recovery | Yes | 9 | S3/DB partial failure, timeout, offline, retry, reconnection |
| Concurrency | Yes | 6 | quota race, double-tap, edit-vs-edit, concurrent link |
| Permissions / tenancy | Yes | 8 | cross-tenant read/link/delete/restore, `@PreAuthorize` gaps |
| State transitions | Yes | 7 | every legal + illegal transition |
| Cross-cutting (offline-sync, time, tenancy, consistency) | Yes | 8 | presigned expiry, orphan accumulation, mail path |
| UX / experience | Yes | 8 | loading/empty/error states, unsaved-data, feedback, double-submit |

Total ≈ 90 cases. Critical-first ordering in §6.

---

## 3. Test cases

Format per `CLAUDE-ba-qa-testcases.md` §3. `[FAILS TODAY]` = current build does not meet the expected
result; the expected result is the **post-fix acceptance bar**.

### 3.1 Happy paths

---
**TC-HAPPY-01 — Upload a receipt photo from mobile docket flow**
Area: happy · Criticality: High · Traces to: R1, flow §3.1
Preconditions: authenticated mobile user, company under quota, an open docket form.
Input: a 400KB JPEG from the gallery.
Steps: open Upload Document → Pick from Gallery → grant permission → select photo → wait → Save docket.
Expected: photo uploads (quality 0.2 re-encode), appears in the attachment list with a success
`Alert`; on Save the `fileKey` is linked to the docket; the docket persists with the attachment;
re-opening the docket shows the image via a fresh presigned URL.
Notes: verify on device; verify the linked file is in `Files` (permanent), not left in `temporary_files`.

---
**TC-HAPPY-02 — Upload a document via mobile document picker**
Area: happy · Criticality: High · Traces to: R1, flow §3.1 step 2, F (filename bug)
Preconditions: as above.
Input: a 1.2MB PDF via "Pick a File".
Steps: Pick a File → choose PDF → Save.
Expected: PDF uploads and links; the stored **filename is the real document name**, not
`[object Object]`.
Notes: `[FAILS TODAY]` — `hooks.tsx:36` passes the whole asset as `fileName`; the stored name is
corrupted. Post-fix: `fileName: file.name`.

---
**TC-HAPPY-03 — Upload attachments in the web generic widget**
Area: happy · Criticality: High · Traces to: R1, flow §3.4
Preconditions: authenticated web user, a form embedding the `Attachments` widget.
Input: 3 files (JPG, PDF, XLSX), each < 2MB.
Steps: drop all 3 → wait → Save the parent record.
Expected: all 3 upload with success notifications; the Add button and control disable during each
upload (no double-submit); on Save all 3 `fileKey`s link to the record.

---
**TC-HAPPY-04 — Set a profile image (web, with crop)**
Area: happy · Criticality: Medium · Traces to: R1, BR2, flow §3.6
Preconditions: authenticated web user on profile page.
Input: a 600KB PNG.
Steps: choose image → crop in `ImgCrop` → confirm → Save profile.
Expected: cropped image uploads (passes the *active* <1MB check), shows in the avatar, links on Save.

---
**TC-HAPPY-05 — Upload a ticket attachment post-creation (the correct one-step flow)**
Area: happy · Criticality: High · Traces to: R1, flow §3.7
Preconditions: an existing ticket, authenticated user with ticket permission.
Input: a 500KB screenshot.
Steps: open ticket details → attach file.
Expected: file uploads directly against `v1/public/{tenantId}/tickets/{id}/attachments`, one step, no
temp/link split; control disabled during upload; attachment appears immediately.
Notes: this is the reference "correct" flow — the pattern the review recommends generalising.

---
**TC-HAPPY-06 — View an attached file**
Area: happy · Criticality: High · Traces to: R2, BR7, flow §2.2
Preconditions: a record with a linked file.
Steps: open the record → tap/click the attachment.
Expected: a fresh presigned GET URL is generated at read time and the file opens; the URL is
time-limited (≈35 min).

---
**TC-HAPPY-07 — Delete then restore a permanent attachment (web)**
Area: happy · Criticality: High · Traces to: R3, BR8, flow §2.3-B, §2.3 step 3
Preconditions: a record with a linked, saved file.
Steps: delete the attachment (tenant-scoped soft-delete) → confirm it's gone → restore from trash.
Expected: delete moves it to trash (`isActive=false`, S3 copied to trash prefix); restore brings it back
(`findByFileKeyAndCompanyIdAndIsActiveFalse`), visible again.

---
**TC-HAPPY-08 — Ticket attachment delete (real backend delete)**
Area: happy · Criticality: Medium · Traces to: R3, flow §3.7 step 4
Preconditions: a ticket with an attachment.
Steps: delete via the Popconfirm.
Expected: `deleteTicketAttachment` calls the backend; the attachment is actually removed (not just from
local state).

---

### 3.2 Business-rule cases (satisfied AND violated)

---
**TC-RULE-01 — BR1 file type allowed (satisfied)**
Area: rule · Criticality: High · Traces to: BR1
Input: a JPG to the generic attachments widget (allow-list includes images).
Expected: accepted and uploaded.

---
**TC-RULE-02 — BR1 file type forbidden (violated)**
Area: rule · Criticality: Critical · Traces to: BR1, F (P0-2)
Input: an `.exe` (or an `.svg` with embedded script) posted **directly to
`POST /api/v1/files/temp/upload`**, bypassing the client widget.
Expected (post-fix): **rejected server-side** with a clear error; nothing written to S3.
Notes: `[FAILS TODAY]` — the temp endpoint runs no extension check; the file is stored. This is the
central P0. Also verify the SVG-XSS vector: an SVG served back must not execute script (force
`Content-Disposition: attachment` or strip script server-side).

---
**TC-RULE-03 — BR2 per-file size at limit (satisfied)**
Area: boundary/rule · Criticality: High · Traces to: BR2
Input: a file exactly at `FilesConfig.maxFileSize`.
Expected: accepted.

---
**TC-RULE-04 — BR2 per-file size over limit (violated)**
Area: boundary/rule · Criticality: High · Traces to: BR2, F (frontend size-check commented out)
Input: a file 1 byte over the limit, posted to the temp endpoint.
Expected (post-fix): rejected server-side.
Notes: `[FAILS TODAY]` on every surface except web profile logo — the client 5MB check is commented out
and the backend temp endpoint enforces only the 20MB blanket cap. A 19MB image on the docket flow is
accepted today.

---
**TC-RULE-05 — BR2 logo size over 1MB (violated, web profile)**
Area: rule · Criticality: Medium · Traces to: BR2, flow §3.6 step 2
Input: a 1.4MB PNG in the profile-image cropper.
Expected: blocked client-side with a message; not uploaded. (This is the one surface where the check is
live — verify it stays live.)

---
**TC-RULE-06 — BR3 consolidated size over limit (violated)**
Area: rule · Criticality: Medium · Traces to: BR3
Preconditions: a record already near `maxConsolidatedSize` for its file type.
Input: one more file that pushes the total over.
Expected (post-fix): rejected at upload/link with a message naming the consolidated cap.

---
**TC-RULE-07 — BR4 attachment count at limit (satisfied)**
Area: boundary/rule · Criticality: Medium · Traces to: BR4, flow §3.4
Input: the 10th attachment on the generic widget (default max 10).
Expected: accepted; the control now blocks an 11th.

---
**TC-RULE-08 — BR4 attachment count over limit (violated)**
Area: boundary/rule · Criticality: Medium · Traces to: BR4
Input: attempt an 11th attachment client-side, and separately post an 11th `fileKey` directly to the
link endpoint.
Expected: client blocks the 11th with a message; **server also rejects** an over-count link payload
(client can be bypassed).

---
**TC-RULE-09 — BR5 quota under allocation (satisfied)**
Area: rule · Criticality: High · Traces to: BR5, flow §2.1 step 4
Preconditions: company at 900MB of its 1GB allocation.
Input: a 50MB upload.
Expected: accepted (under 1GB).

---
**TC-RULE-10 — BR5 quota exceeded (violated)**
Area: rule · Criticality: High · Traces to: BR5
Preconditions: company at 990MB of 1GB.
Input: a 50MB upload.
Expected: rejected with a "storage limit reached" message; nothing written.
Notes: verify the message is user-visible on mobile (today mobile swallows errors — see TC-FAIL-04).

---
**TC-RULE-11 — BR6 tenant isolation on read (violated attempt)**
Area: permission · Criticality: Critical · Traces to: BR6, flow §2.2
Preconditions: user of Company A; a `guuid`/`fileKey` belonging to Company B.
Steps: request Company B's file via every read path.
Expected: denied / not-found; no bytes returned.
Notes: permanent-table reads are correctly scoped today; this case guards against regression.

---
**TC-RULE-12 — BR6 tenant isolation on temp-file delete (violated attempt)**
Area: permission · Criticality: Critical · Traces to: BR6, F (P0-4), flow §2.3-B temp branch
Preconditions: user of Company A; Company B's temp `fileKey` (leaked/observed from an upload response).
Steps: call the delete-by-key path with Company B's temp key.
Expected (post-fix): denied — the lookup is scoped by `company_fk`.
Notes: `[FAILS TODAY]` — `temporary_files` has no company column; the delete succeeds cross-tenant.
Requires the schema migration to fix.

---
**TC-RULE-13 — BR6 tenant isolation on link/promotion (violated attempt)**
Area: permission · Criticality: Critical · Traces to: BR6, review cross-lens #2
Preconditions: user of Company A; Company B's temp `fileKey`.
Steps: save a Company A record with Company B's temp `fileKey` in the `create.fileKey` list.
Expected (post-fix): the promotion rejects the foreign key (ownership checked at link time).
Notes: `[FAILS TODAY]` — promotion looks up by key alone; Company A can adopt Company B's staged file.

---
**TC-RULE-14 — BR7 private storage / no public URL (satisfied)**
Area: rule · Criticality: High · Traces to: BR7, flow §2.1 step 5
Steps: take the raw `fileUrl` from an upload response and open it without signing.
Expected: access denied by S3 (object is `ACL.PRIVATE`); only the presigned URL works.
Notes: also flag that the raw `fileUrl`/`fileKey` should not be returned to the client at all (review
P1-3) — a hardening case, not just a pass/fail.

---
**TC-RULE-15 — BR8 soft-delete recoverable (satisfied)**
Area: rule/state · Criticality: High · Traces to: BR8
Covered by TC-HAPPY-07; asserts the deleted file is recoverable, not physically gone.

---
**TC-RULE-16 — BR8 hard-delete-by-id is NOT a legitimate user action (violated)**
Area: permission · Criticality: Critical · Traces to: BR6/BR8, F (P0-3), flow §2.3-A
Preconditions: user of Company A; a sequential numeric `id` belonging to Company B's permanent file.
Steps: `DELETE /api/v1/files/delete/{id}` with Company B's id.
Expected (post-fix): denied (endpoint gated by `@PreAuthorize` + company filter, or removed entirely).
Notes: `[FAILS TODAY]` — no auth annotation, no company filter, real irreversible S3 delete. **Highest
severity single item.** Same for the third mechanism `DELETE /api/v1/files/delete` (Errata #3).

---

### 3.3 Boundary cases

---
**TC-BOUND-01 — Zero-byte file** · boundary · High · BR2
Input: a 0-byte file. Expected: rejected with a clear message on every surface (client and server); no
empty object staged.

---
**TC-BOUND-02 — File exactly at the 20MB Spring cap** · boundary · Medium · BR2
Input: a 20MB file to the temp endpoint. Expected: accepted only if within `FilesConfig.maxFileSize`
(post-fix); at 20MB+1 the multipart parser rejects with a clean 413-style error, not a 500.

---
**TC-BOUND-03 — Empty attachment list on save** · boundary · Medium · R1
Steps: save a docket/record with zero attachments. Expected: saves normally; no empty `create.fileKey`
side effects.

---
**TC-BOUND-04 — Single vs many attachments** · boundary · Low · BR4
Input: 1 file, then a batch of 10. Expected: both handled; the 10th is the last accepted at default cap.

---
**TC-BOUND-05 — Maximum-length / unicode filename** · boundary · Medium · flow §2.1 step 2
Input: a 255-char filename with unicode/emoji and a path-traversal attempt (`../../etc/passwd.jpg`).
Expected: filename is sanitised before it becomes part of the S3 key; no traversal, no key collision, no
broken tooling. Notes: `[FAILS TODAY]` — filename embedded raw (flow §2.1 step 2, review P2-2).

---
**TC-BOUND-06 — Very long attachment list posted directly** · boundary · High · BR4
Input: a link payload with 1,000 `fileKey`s. Expected (post-fix): server caps/rejects; no unbounded
processing.

---
**TC-BOUND-07 — Quota exactly at allocation (limit)** · boundary · High · BR5
Preconditions: company at exactly 1GB. Input: any upload. Expected: rejected (at limit, not under).

---
**TC-BOUND-08 — Quota at limit−1 byte** · boundary · High · BR5
Preconditions: company 1 byte under. Input: a 1-byte file. Expected: accepted; next byte rejected.

---
**TC-BOUND-09 — First-ever upload for a brand-new company** · boundary · Medium · R1, first-run
Preconditions: new company, no `CompanyStorageAllocation` row yet (or default 1GB just provisioned).
Expected: upload works if the allocation row exists; if missing, a clear "storage not configured" error
(fail-closed), not a silent null-company upload (flow §2.1 step 3).

---
**TC-BOUND-10 — Filename with no extension** · boundary · Low · BR1
Input: a file named `receipt` (no extension). Expected: rejected by the extension allow-list, or typed
from sniffed content (post-fix), not silently accepted.

---

### 3.4 Negative / invalid cases

---
**TC-NEG-01 — Spoofed MIME type** · negative · Critical · BR1, review cross-lens #1
Input: an HTML/JS payload renamed `avatar.png` with `Content-Type: image/png`.
Expected (post-fix): content is sniffed (magic bytes), not trusted; the mismatch is rejected. Notes:
`[FAILS TODAY]` — no content sniffing anywhere; the client `Content-Type` header is trusted.

---
**TC-NEG-02 — SVG with embedded `<script>`** · negative · Critical · BR1, F (P0-4)
Input: a malicious SVG as a profile image. Expected (post-fix): SVG removed from the allow-list, or
sanitised + served as `attachment` so it never executes in the app origin. Notes: stored-XSS vector.

---
**TC-NEG-03 — Malformed multipart body** · negative · Medium · flow §3.1 step 5
Input: a request with the `"file"` field appended twice (the mobile FormData bug), and separately a
truncated multipart body. Expected: backend handles gracefully with a typed 400, not a 500; the double
`"file"` field is deduped/rejected deterministically. Notes: `[FAILS TODAY]` mobile always double-appends
(flow §3.1 step 5) — verify the backend's actual behaviour and fix the client.

---
**TC-NEG-04 — Missing required link fields** · negative · Medium · R1
Input: a save payload with `create.fileKey` referencing a non-existent key. Expected: rejected with a
clear message; the record save either fails atomically or clearly reports the bad key.

---
**TC-NEG-05 — Wrong state for the action (link an already-linked key)** · negative/state · High · state machine
Input: a `fileKey` that's already been promoted to a permanent `Files` row, submitted again in a new
save. Expected: no-op or clear rejection; **not** a duplicate permanent row.

---
**TC-NEG-06 — Restore a file that isn't trashed** · negative/state · Medium · BR8
Steps: call restore on an active (non-trashed) file. Expected: rejected / no-op; no state corruption.

---
**TC-NEG-07 — SQL/injection-style filename or description** · negative · Medium · security
Input: a description of `'); DROP TABLE files;--` and a filename with SQL metacharacters. Expected:
parameterised queries neutralise it; stored verbatim as data, no execution.

---
**TC-NEG-08 — Upload flood (no rate limit)** · negative · High · review P2-12, open question
Steps: fire 500 rapid uploads to the temp endpoint from one user. Expected (post-fix): rate-limited
(the codebase already has a rate-limit mechanism used elsewhere). Notes: unconfirmed whether any limit
exists today — treat as a gap to verify.

---
**TC-NEG-09 — Forbidden action: upload without permission** · negative/permission · High · BR6
Preconditions: a user whose role lacks file/attachment permission. Steps: attempt an upload/link.
Expected (post-fix): denied by `@PreAuthorize` on the temp/upload routes (currently absent). Notes:
`[FAILS TODAY]` — the temp upload and hard-delete routes have no `@PreAuthorize`.

---
**TC-NEG-10 — Unsupported Office/older format** · negative · Low · BR1
Input: a `.pages` or `.heic` file where the surface's allow-list excludes it. Expected: rejected
client-side with a message naming the accepted types; server also rejects if bypassed.

---

### 3.5 Failure & recovery cases

---
**TC-FAIL-01 — S3 write succeeds, DB insert fails (create path)** · failure · High · F (P1-7), flow §2.1
Steps: force the `Files`/`TemporaryFile` insert to throw after the S3 `putObject` succeeds.
Expected (post-fix): no orphaned S3 object — either the object is cleaned up, or a reconciliation sweeper
reaps it; a `PENDING`/`FAILED` status row makes it findable. Notes: `[FAILS TODAY]` — orphan is
permanent, no reconciliation job exists.

---
**TC-FAIL-02 — Update path: new upload fails after old deleted** · failure · High · F (P1-7), flow §2.4
Steps: on replace, let the new upload throw after the old S3 object is deleted.
Expected (post-fix): reorder to upload-new-first / swap / delete-old-after-commit, so failure leaves the
**old** file valid — never an active row pointing at a deleted key. Notes: `[FAILS TODAY]` — dangling
reference, row looks healthy until fetched.

---
**TC-FAIL-03 — Batch delete: one key's S3 delete throws mid-loop** · failure · High · F (P1-7 new finding)
Steps: delete a batch of keys; make a later key throw a raw S3 exception.
Expected (post-fix): earlier keys' state stays consistent — either each key in its own transaction, or a
compensating cleanup; no DB rows left "active" pointing at already-deleted S3 objects.

---
**TC-FAIL-04 — Upload fails on mobile (network error)** · failure/UX · High · F (mobile swallows errors), flow §3.1 step 8
Steps: kill connectivity mid-upload on mobile. Expected (post-fix): a visible error + a retry
affordance. Notes: `[FAILS TODAY]` — `.catch(err => console.log(err))`, nothing shown to the user, file
silently missing.

---
**TC-FAIL-05 — Upload hangs (no client timeout)** · failure/UX · High · F (P1-6 / no timeout), flow §3.1 step 6
Steps: stall the network mid-POST on mobile. Expected (post-fix): the request times out with a clear
message; the UI doesn't hang indefinitely. Notes: `[FAILS TODAY]` — no client timeout anywhere.

---
**TC-FAIL-06 — Slow S3 exhausts the DB connection pool** · failure · High · F (P1-6), review §3
Steps: simulate S3 latency under concurrent uploads. Expected (post-fix): S3 client has
`apiCallTimeout`/`apiCallAttemptTimeout`; the S3 call doesn't hold a DB connection open for its full
duration. Notes: `[FAILS TODAY]` — pure SDK defaults, S3 call inside the DB transaction.

---
**TC-FAIL-07 — Retry double-applies (no idempotency)** · failure/concurrency · High · F (no idempotency)
Steps: a client retries a timed-out upload that actually succeeded. Expected (post-fix): a
client-generated idempotency key dedupes; one file, not two. Notes: `[FAILS TODAY]` — a retry creates a
second file/object.

---
**TC-FAIL-08 — Presigned URL generation fails** · failure/UX · Medium · F (P1-8), flow §2.2
Steps: force `generatePreSignedUrl` to hit an `SdkClientException`. Expected (post-fix): returns
`null`/error the caller can detect; the UI shows a broken-image/retry state. Notes: `[FAILS TODAY]` —
returns the literal string `"Error generating pre-signed URL"` as if it were a real URL.

---
**TC-FAIL-09 — Global exception handler returns wrong shape** · failure · High · F (P0-1, Errata #4)
Steps: trigger a genuine `java.lang.IllegalArgumentException` (e.g. delete a non-existent file id).
Expected (post-fix): the app's standard `ApiResponse` envelope with the correct status. Notes:
`[FAILS TODAY]` — the same-package class-name collision means the JDK exception is never caught; the
response falls through to Spring's default `/error` shape. Also: a `ResourceNotFoundException` returns
HTTP 200 with a body that says 404 (review DoD #7) — assert HTTP status matches the body.

---

### 3.6 Concurrency cases

---
**TC-CONC-01 — Quota race: two concurrent uploads near the cap** · concurrency · Critical · BR5, F (P1-5)
Preconditions: company at 990MB of 1GB. Steps: fire two 20MB uploads simultaneously. Expected
(post-fix): at most one succeeds; the atomic guarded `UPDATE` prevents both passing. Notes:
`[FAILS TODAY]` — both read the same live `SUM`, both pass, company overshoots to 1030MB.

---
**TC-CONC-02 — Double-tap on mobile pick button** · concurrency · High · F (no disabled guard), flow §3.1 step 11
Steps: double-tap "Pick from Gallery" quickly. Expected (post-fix): the button disables during upload;
one attachment, not two. Notes: `[FAILS TODAY]` — two concurrent dispatches, duplicate attachments.

---
**TC-CONC-03 — Two users link the same temp key concurrently** · concurrency · High · state, review cross-lens #2
Steps: two saves reference the same temp `fileKey`. Expected: exactly one promotion succeeds; the other
is a clean no-op/rejection — never two permanent rows for one temp object.

---
**TC-CONC-04 — Edit-vs-edit on the same file's metadata** · concurrency · Medium · flow §2.4
Steps: two users edit the same file's record-link metadata at once. Expected: last-write-wins with no
corruption, or an optimistic-lock rejection — a defined outcome, not a torn state.

---
**TC-CONC-05 — Concurrent delete + restore of the same file** · concurrency · Medium · BR8
Steps: user A deletes while user B restores the same file. Expected: a defined final state (trashed or
active), no duplicate S3 objects, no dangling row.

---
**TC-CONC-06 — Concurrent identical uploads to the same record** · concurrency · Medium · BR4
Steps: two devices upload the "last allowed" attachment (count at cap−1) simultaneously. Expected: the
count cap holds server-side; only one is accepted if it would breach the cap.

---

### 3.7 Permission / tenancy cases

*(BR6 is covered functionally in TC-RULE-11/12/13/16; these add role/scope dimensions.)*

---
**TC-PERM-01 — Cross-tenant read via guessed guuid** · permission · Critical · BR6 — covered by TC-RULE-11.

---
**TC-PERM-02 — Cross-tenant temp-file delete** · permission · Critical · BR6 — covered by TC-RULE-12 `[FAILS TODAY]`.

---
**TC-PERM-03 — Cross-tenant link/adoption** · permission · Critical · BR6 — covered by TC-RULE-13 `[FAILS TODAY]`.

---
**TC-PERM-04 — Cross-tenant hard-delete-by-id** · permission · Critical · BR6 — covered by TC-RULE-16 `[FAILS TODAY]`.

---
**TC-PERM-05 — Role without file permission is blocked** · permission · High · BR6 — covered by TC-NEG-09.

---
**TC-PERM-06 — Permission revoked mid-flow** · permission · Medium · cross-cutting
Steps: a user picks files, then has their file permission revoked before saving the parent record.
Expected: the link/promotion step re-checks permission and denies; no orphaned adoption.

---
**TC-PERM-07 — Wrong location scope** · permission · Medium · flow §2.2 (location filter)
Preconditions: a user scoped to Location X; a file linked to Location Y within the same company.
Steps: attempt to read it via the location-filtered list. Expected: excluded from the results per the
accessible-location filter.

---
**TC-PERM-08 — Null-company file is unreachable by normal paths** · permission · High · F (P2-11)
Preconditions: a `Files` row with `company_fk = NULL` (silently created when guuid didn't resolve).
Steps: attempt to read/delete it via tenant-scoped paths. Expected (post-fix): such a row can't be
created at all (company enforced NOT NULL, upload rejected if unresolved). Notes: `[FAILS TODAY]` — a
null-company row is invisible to scoped queries and reachable only via the unscoped hard-delete.

---

### 3.8 State-transition cases

---
**TC-STATE-01 — none → temp** · state · High · state machine
Upload a file without saving the parent. Expected: a `temporary_files` row exists; no permanent row yet.

---
**TC-STATE-02 — temp → permanent (promotion)** · state · High · flow §5 step 15 (assumption)
Save the parent with the temp `fileKey`. Expected: the temp file becomes a permanent, entity-linked
`Files` row. Notes: verify the exact promotion (does the S3 object move or the key re-point?) — the open
question from flow §5.

---
**TC-STATE-03 — temp → orphan (abandoned)** · state · High · R6, F (no reaper)
Upload, then abandon the form (never save). Expected (post-fix): a reaper reclaims the unlinked temp row
+ S3 object after a TTL. Notes: `[FAILS TODAY]` — accumulates forever.

---
**TC-STATE-04 — permanent → trashed → permanent** · state · High · BR8 — covered by TC-HAPPY-07.

---
**TC-STATE-05 — trashed → purged (permanent delete)** · state · Medium · flow §3.9 step 4
Permanently delete a trashed docket. Expected (post-fix): the file is physically removed. Notes:
`[FAILS TODAY]` on the web Deleted-Dockets screen — the permanent-delete handler body is commented out;
the button does nothing.

---
**TC-STATE-06 — Illegal: delete an already-trashed file again** · state · Medium · BR8
Expected: no-op or clear rejection; no double-processing.

---
**TC-STATE-07 — Illegal: act on a purged/gone key** · state · Medium · state machine
Link or view a `fileKey` that's been purged. Expected: clean not-found, no 500, no resurrection.

---

### 3.9 Cross-cutting cases

---
**TC-CROSS-01 — Presigned URL expiry boundary** · time · Medium · BR7, flow §2.2
Steps: open a file, wait past 35 min on the same rendered URL, retry. Expected: the stale URL fails
cleanly; a fresh read regenerates a working URL. Notes: verify the "attach existing doc" drawer (§3.10)
which reuses a possibly-lapsed `preSignedUrl` without refresh.

---
**TC-CROSS-02 — Orphan accumulation over time** · consistency · High · R6, F (no reaper)
Steps: upload-then-abandon 100 times; check `temporary_files` + S3. Expected (post-fix): reaper keeps
the count bounded. Notes: `[FAILS TODAY]` — unbounded growth, no cleanup.

---
**TC-CROSS-03 — Ticket-form attachments silently dropped** · consistency/UX · High · F (§3.8), review cross-lens
Steps: attach files while creating a ticket → submit. Expected (post-fix): attachments are linked to the
ticket. Notes: `[FAILS TODAY]` — the link line is commented out; files upload, show as attached, then
vanish with no error. Silent data loss.

---
**TC-CROSS-04 — Inbound email attachment stored against correct company** · tenancy · High · R5, flow §2.6
Steps: send an email with an attachment into the ingestion pipeline. Expected: stored against the right
company; a same-named second attachment does **not** overwrite the first. Notes: `[FAILS TODAY]` — the
mail S3 key has no UUID segment; same-filename attachments collide/overwrite (flow §2.6 step 3).

---
**TC-CROSS-05 — Malicious inbound email content** · security/tenancy · High · flow §2.6
Steps: send an email whose attachment filename/content is hostile (script SVG, traversal filename).
Expected (post-fix): the same server-side validation/sniffing/sanitising as browser uploads applies to
the email path (it currently shares the pipeline, so the same fixes must cover it).

---
**TC-CROSS-06 — Redundant raw `fileUrl` in response** · consistency/security · Medium · F (P1-3)
Steps: inspect any upload/read response. Expected (post-fix): only the presigned URL is returned; the raw
`fileUrl`/`fileKey` are not exposed. Notes: `[FAILS TODAY]` — both are returned.

---
**TC-CROSS-07 — Two mobile pickers diverge** · consistency · Low · flow §3.2, §6
Verify the live picker (`hooks.tsx`, quality 0.2, permission-handled) vs the dead
`ImagePickerComponent` (quality 1, no permission handling). Expected (post-fix): one shared,
consistent implementation; the dead one removed or reconciled.

---
**TC-CROSS-08 — Data consistency: DB row vs S3 object** · consistency · High · F (P1-7)
Steps: audit for `Files` rows with `isActive=true` whose `fileKey` 404s in S3. Expected (post-fix): a
reconciliation check surfaces these; ideally zero. Notes: caused by the update-path ordering bug (§2.4).

---

### 3.10 UX / experience cases

---
**TC-UX-01 — Loading state during upload (web)** · UX · Medium · flow §3.4 step 7
Expected: control + Add button show loading and are disabled; cleared on success/failure.

---
**TC-UX-02 — Loading state during upload (mobile)** · UX · High · flow §3.1 step 11
Expected (post-fix): pick buttons disabled while uploading; a spinner shows progress. Notes:
`[FAILS TODAY]` — no disabled state.

---
**TC-UX-03 — Success feedback** · UX · Medium · flow §3.1 step 7, §3.4 step 5
Expected: every surface confirms success (Alert/notification/message) — consistent across mobile and web.

---
**TC-UX-04 — Error feedback** · UX · High · F (mobile swallows errors)
Expected (post-fix): every surface shows a clear error on failure. Notes: `[FAILS TODAY]` on mobile.

---
**TC-UX-05 — Empty state** · UX · Low · R1
A record with no attachments shows a clear empty state (e.g. engage-mobile's "No attachments found"),
not a broken/blank area.

---
**TC-UX-06 — Unsaved-data protection** · UX · Medium · flow §3.1 step 9
Steps: upload files, then navigate away without saving the parent. Expected: a warning about unsaved
attachments (and, post-fix, the staged temp files are reaped rather than silently orphaned).

---
**TC-UX-07 — App backgrounded mid-upload (mobile)** · UX · Medium · cross-cutting
Steps: background the app during an upload. Expected: on return, a defined state (completed, or a visible
retry) — not a silent partial.

---
**TC-UX-08 — Broken-image fallback on expired/failed URL** · UX · Medium · TC-FAIL-08, TC-CROSS-01
Expected: a placeholder/retry, not a broken-image icon from a literal-error-string "URL".

---

## 4. Edge-case scenarios (the commonly-missed ones — called out explicitly)

Per `CLAUDE-ba-qa-testcases.md` §5, the edges teams forget — each is a case above, gathered here so
they're not lost:

- **Empty / zero / null** — TC-BOUND-01 (0-byte), TC-BOUND-03 (no attachments), TC-PERM-08
  (null-company row).
- **First-run / fresh state** — TC-BOUND-09 (brand-new company, no allocation row).
- **Maximum / overflow** — TC-BOUND-02 (20MB cap), TC-BOUND-06 (1,000-key link payload), TC-BOUND-05
  (255-char unicode filename).
- **Duplicate / repeat** — TC-NEG-05 (re-link a linked key), TC-FAIL-07 (retry double-apply),
  TC-CROSS-04 (same-filename email overwrite).
- **Out-of-order** — TC-STATE-06/07 (act on already-trashed / purged), TC-CONC-03 (concurrent promotion).
- **Concurrent identical** — TC-CONC-01 (quota race), TC-CONC-02 (double-tap), TC-CONC-06 (last-slot
  attachment).
- **Offline → sync** — TC-FAIL-04 (mobile network drop), TC-UX-07 (backgrounded), TC-FAIL-05 (hang).
- **Permission / subscription change mid-flow** — TC-PERM-06 (revoked before save).
- **Abandonment / interruption** — TC-STATE-03 (abandon → orphan), TC-UX-06 (navigate away),
  TC-CROSS-02 (orphan accumulation).
- **Time** — TC-CROSS-01 (presigned expiry boundary).
- **Connectivity transitions** — TC-FAIL-04/05, TC-UX-07.
- **Long / unusual input** — TC-BOUND-05 (unicode/traversal filename), TC-NEG-07 (injection).
- **State edge** — TC-STATE-05/06/07, TC-CROSS-08 (row vs object drift).
- **Adversarial content** — TC-NEG-01 (spoofed MIME), TC-NEG-02 (script SVG), TC-CROSS-05 (hostile
  email attachment).

---

## 5. Coverage summary — requirement / rule / transition → case(s)

| Requirement / Rule / Transition | Satisfied case | Violated / failure case | Status today |
|---|---|---|---|
| R1 upload works | TC-HAPPY-01…05 | TC-NEG-03/04 | Works (with bugs) |
| R2 view works | TC-HAPPY-06 | TC-FAIL-08, TC-CROSS-01 | Works |
| R3 delete works | TC-HAPPY-07/08 | TC-STATE-05 (permanent-delete dead) | Partial `[FAILS]` |
| R4 update/replace | TC-HAPPY (implied) | TC-FAIL-02 | `[FAILS]` on failure path |
| R5 email stored correctly | TC-CROSS-04 | TC-CROSS-05 | `[FAILS]` (key collision) |
| R6 no orphan accumulation | TC-STATE-03 | TC-CROSS-02 | `[FAILS]` (no reaper) |
| BR1 file type | TC-RULE-01 | TC-RULE-02, TC-NEG-01/02/10 | `[FAILS]` server-side |
| BR2 per-file size | TC-RULE-03, TC-RULE-05 | TC-RULE-04, TC-BOUND-01/02 | `[FAILS]` except logo |
| BR3 consolidated size | (implied) | TC-RULE-06 | `[FAILS]` (deferred to link) |
| BR4 attachment count | TC-RULE-07 | TC-RULE-08, TC-BOUND-06 | Partial (client only) |
| BR5 storage quota | TC-RULE-09, TC-BOUND-08 | TC-RULE-10, TC-BOUND-07, TC-CONC-01 | `[FAILS]` (race) |
| BR6 tenant isolation | TC-RULE-11 | TC-RULE-12/13/16, TC-PERM-01…08 | `[FAILS]` (temp table, deletes) |
| BR7 private storage | TC-RULE-14 | TC-CROSS-06 | Works (raw URL leaks) |
| BR8 soft-delete/restore | TC-RULE-15, TC-HAPPY-07 | TC-RULE-16, TC-NEG-06, TC-STATE-06 | Partial |
| none→temp | TC-STATE-01 | — | Works |
| temp→permanent | TC-STATE-02 | TC-NEG-05, TC-CONC-03 | Works (untraced detail) |
| temp→orphan | — | TC-STATE-03, TC-CROSS-02 | `[FAILS]` |
| permanent→trashed→permanent | TC-HAPPY-07, TC-STATE-04 | TC-CONC-05 | Works |
| trashed→purged | — | TC-STATE-05 | `[FAILS]` (dead handler) |
| permanent→(replace)→permanent | TC-HAPPY (implied) | TC-FAIL-02 | `[FAILS]` on failure |
| Global error handling | — | TC-FAIL-09 | `[FAILS]` (handler collision) |
| Idempotency / retry | — | TC-FAIL-07 | `[FAILS]` (none) |
| Partial failure / reconciliation | — | TC-FAIL-01/02/03, TC-CROSS-08 | `[FAILS]` (no sweeper) |

**Coverage gaps (need a case or a decision before "done"):**
- The exact temp→permanent promotion mechanism is untraced (TC-STATE-02 assumption) — confirm and firm
  up the expected result.
- Whether a rate limit exists on the temp endpoint (TC-NEG-08) — verify, then set the expected result.
- The real `FilesConfig` extension/size values per entity/file-type (BR1/BR2 satisfied cases) — dump the
  table to finalise the exact accepted/rejected inputs.

---

## 6. Priority roll-up — run these first

**Critical (money/auth/data-integrity/tenancy — must pass before ship):**
- TC-RULE-16 / TC-PERM-04 — cross-tenant hard-delete-by-id (highest single item).
- TC-RULE-12 / TC-PERM-02 — cross-tenant temp-file delete.
- TC-RULE-13 / TC-PERM-03 — cross-tenant link/adoption.
- TC-RULE-11 / TC-PERM-01 — cross-tenant read.
- TC-RULE-02 / TC-NEG-01 / TC-NEG-02 — unvalidated upload + spoofed MIME + script SVG (stored-XSS).
- TC-CONC-01 — quota race.
- TC-FAIL-09 — broken global exception handler.

**High (core flows, key rules, common failures, offline):**
- TC-HAPPY-01…05 (each surface works), TC-CROSS-03 (ticket-form silent data loss), TC-STATE-03 /
  TC-CROSS-02 (orphan accumulation), TC-FAIL-01/02/03 (partial-failure reconciliation), TC-FAIL-04/05
  (mobile error/timeout), TC-FAIL-06 (S3 pool exhaustion), TC-FAIL-07 (idempotency), TC-CONC-02
  (double-tap), TC-RULE-04/10 (size + quota enforcement), TC-BOUND-06 (unbounded link payload),
  TC-CROSS-04 (email key collision), TC-PERM-08 (null-company row), TC-NEG-09 (missing `@PreAuthorize`).

**Medium / Low:** the remaining boundary, UX-state, and consistency cases — run after the Critical/High
set is green.

---

## 7. Open questions (need product/dev confirmation to finalise expected results)

1. **Promotion mechanics** — how exactly does a `TemporaryFile` become a permanent `Files` row (S3 move
   vs key re-point)? Blocks the precise expected results of TC-STATE-02, TC-CONC-03.
2. **Rate limiting** — is there any limit in front of `POST /api/v1/files/temp/upload` today? Sets the
   expected result of TC-NEG-08.
3. **`FilesConfig` real values** — the full `validExtensions` / `maxFileSize` / `maxConsolidatedSize` /
   `maxAttachmentsAllowed` per entity/file-type, to fix the exact accept/reject inputs for BR1–BR4.
4. **Trash retention window** — how long before a trashed file is eligible for physical purge? Sets
   TC-STATE-05's timing.
5. **SVG requirement** — is SVG genuinely needed as an image type anywhere? Determines whether TC-NEG-02's
   fix is "remove from allow-list" or "sanitise + serve as attachment."
6. **`Files.fileData` blob rows** — do any exist in production (from the dead `FilesHelper` path)? Affects
   whether its removal needs a data migration first (relevant to any test that touches that column).
7. **Default quota reality** — is 1GB the shipping default for all plans, or plan-dependent? Sets the
   preconditions for BR5 cases (TC-RULE-09/10, TC-BOUND-07/08, TC-CONC-01).

---

*This test-case set is exhaustive against the documented flow and the four-lens findings. Cases marked
`[FAILS TODAY]` double as the acceptance tests for the remediation work in `image-upload-flow-review.md`
§ "Build order." When every Critical and High case passes, the feature meets the production-ready bar.*
