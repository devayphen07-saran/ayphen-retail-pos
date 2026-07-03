# API Reference — Verified Endpoint Catalog

> **App:** Ayphen Retail backend (`apps/api`, NestJS). **Every route below was read from the actual
> controllers** (file:line cited) — this is the source-of-truth endpoint list the other PRDs must
> reconcile against.
> **Global prefix:** `app.setGlobalPrefix('api')` + URI versioning default `v1` → **every path is
> `/api/v1/…`** (`main.ts`).
> **Auth chain (global):** `ThrottlerGuard → WebSessionGuard → MobileJwtGuard → JwtAuthGuard`; `@Public()`
> bypasses the final gate. Most mobile controllers add `@SkipTransform()` (raw body, no `{data:…}` envelope).
> **ID convention:** `:storeId`/`:deviceGuuid`/`:roleId`/… in paths are **guids**; `@StoreContext` resolves
> the guid → numeric `id` internally.
> **Legend:** ✅ matches docs · ⚠️ docs stale/wrong · 🆕 exists, not in docs · ❌ documented but NOT built.

---

## Table of contents
1. [Auth & session](#1-auth--session)
2. [Me / profile / user-level](#2-me--profile--user-level)
3. [Stores · device-access · context · hours](#3-stores--device-access--context--hours)
4. [User-level devices](#4-user-level-devices)
5. [Sync](#5-sync)
6. [Subscription & billing](#6-subscription--billing)
7. [RBAC · invitations · shifts · ownership transfer](#7-rbac--invitations--shifts--ownership-transfer)
8. [Documented but NOT built](#8-documented-but-not-built-wrong--unnecessary)
9. [Stale-doc corrections (backend is ahead)](#9-stale-doc-corrections--the-backend-moved-ahead)
10. [Per-doc fix list](#10-per-doc-fix-list)

---

## 1. Auth & session

`MobileAuthController` `@Controller('auth')` → **`/api/v1/auth/...`** but **all mobile auth lives under
`/auth/mobile/...`** (the sub-paths include `mobile/`). `TimeController` is separate.

| Verb | Full path | Request | Response | Guards | Notes |
|---|---|---|---|---|---|
| GET | `/api/v1/time` | — | `{ server_time_ms, server_time_iso }` | `@Public` | clock-skew source ✅ |
| GET | `/api/v1/auth/mobile/app-version` | `?platform=&version=` | `AppVersionCheckResult` | `@Public` | force-update check ✅ |
| POST | `/api/v1/auth/mobile/challenge` | — | `{ challengeId, challenge, expiresAt }` | `@Public`, 20/min | 🆕 device nonce for refresh-sig + biometric step-up |
| POST | `/api/v1/auth/mobile/signup` | `SignupDto` (OTP 2-stage + `consent`) | tokens \| OTP challenge | `@Public`, 3/hr | 🆕 **not in docs** — separate from login |
| POST | `/api/v1/auth/mobile/login` | `LoginDto {method:'otp', phone, otpCode?, otp_request_id?, device?}` | `LoginTokenResponseDto` \| `OtpChallengeResponseDto` | `@Public`, 5/min | ⚠️ docs say `POST /auth/login` — real path is **`/auth/mobile/login`** |
| POST | `/api/v1/auth/mobile/refresh` | `RefreshDto {refreshToken, idempotencyKey, challengeId?, deviceSignature?, snapshotVersion?}` | `RefreshResponseDto` | `@Public`, 30/min | ⚠️ real path `/auth/mobile/refresh`; **`idempotencyKey` is REQUIRED** (single-flight, mobile-09 INV-3) |
| POST | `/api/v1/auth/mobile/logout` | `?all_devices=true?` | `LogoutResponseDto` | `@Public` | ⚠️ real path `/auth/mobile/logout`; idempotent, always 200 |
| POST | `/api/v1/auth/mobile/otp/request` | `OtpRequestDto {phone, purpose?, resend_of?}` | `{ otp_request_id, phone_masked, expires_in_seconds, … }` | `@Public`, 3/min | 🆕 standalone OTP (step-up/resend) — not in docs |
| POST | `/api/v1/auth/mobile/step-up` | `StepUpDto {method, credential, otp_request_id?, challenge_id?}` | `StepUpResponseDto {valid_until}` | auth, 5/min | ⚠️ real path `/auth/mobile/step-up` |
| GET | `/api/v1/auth/mobile/sessions` | — | `SessionsListResponseDto` | auth | 🆕 list device sessions — not in docs |
| POST | `/api/v1/auth/mobile/sessions/revoke-others` | — | `RevokeOtherSessionsResponseDto` | auth | 🆕 revoke all but current — not in docs |
| POST | `/api/v1/auth/web/step-up` + `ALL /api/v1/auth/web/*` | — | — | web/CSRF | web only — out of mobile scope |

**RefreshResponseDto:** `{ access_token, refresh_token, snapshot: PermissionSnapshot|null,
snapshot_signature: string|null, snapshot_changed, force_bootstrap, store_access_changed }`.
**LoginTokenResponseDto:** `{ access_token, refresh_token, user:{id, permissions_version}, is_new_user,
device_guuid, device_session_guuid, is_trusted }`.

> **Device registration** is folded into login/signup stage-2 `device:{publicKey, platform, model,
> osVersion, appVersion, attestation}` — there is **no** `POST /devices/register` (matches docs ✅).
> Source: `auth/mobile/controllers/mobile-auth.controller.ts`, `modules/sync/controllers/time.controller.ts`.

---

## 2. Me / profile / user-level

`MeController` `@Controller('me')` (`modules/me/controllers/me.controller.ts`). Controller-wide
`@SkipSubscriptionCheck()` + `@SkipTransform()`.

| Verb | Full path | Request | Response | ETag/304 | Notes |
|---|---|---|---|---|---|
| GET | `/api/v1/me/bootstrap` | — | `BootstrapResponseDto` | `W/"<pv>-<updatedAt>"` | ✅; throttle 5/10s |
| GET | `/api/v1/me/pv` | — | `{ permissions_version }` | `W/"pv-<pv>"` | ✅ |
| GET | `/api/v1/me/snapshot` | — | `{ snapshot, snapshot_signature, permissions_version }` | `W/"snap-<pv>"` | ✅ base exists; ❌ **no `?store=` variant** (mobile-01 Phase-2 lever unbuilt) |
| GET | `/api/v1/me/invitations` | — | `BootstrapInvitationDto[]` | — | ✅ |
| GET | `/api/v1/me/devices` | — | `ListDevicesResponseDto` | — | ✅ |
| PATCH | `/api/v1/me` | `UpdateProfileDto {name, email, image_attachment_id}` | `BootstrapResponseDto` | — | ✅ |
| PATCH | `/api/v1/me/account-mode` | `{mode:'business'\|'personal'}` | `BootstrapResponseDto` | — | ✅ |
| PATCH | `/api/v1/me/preferences` | `{last_opened_store_id?, default_store_id?}` (≥1, nullable) | `BootstrapResponseDto` | — | ✅ the active-store writer (not `POST /me/active-store`) |

**BootstrapResponseDto (verified fields):**
```
{ user:{ id, guuid, name, email, phone, image, image_attachment_id, email_verified,
         phone_verified, last_account_mode, mfa_enabled, permissions_version },
  snapshot, snapshot_signature, permissions_version,
  preferences:{ theme, timezone, notifications_enabled, last_opened_store_id, default_store_id },
  has_pending_invitations: boolean,                    // ✅ already present
  profile_status, missing_fields,
  active_store_id: string|null,                        // deprecated
  active_store: { id, guuid } | null,                  // ✅ already present (mobile-02 §3c "ADD" = DONE)
  active_store_access: { status:'granted', is_new_slot } | { status:'limit_reached', device_limit, active_device_count } | null,
  active_store_logo_attachment_id: string|null }
```
> ⚠️ **mobile-02 §3c / mobile-06 §8B.4 / mobile-07 §8a/Phase 0.2** all describe `active_store {id,guuid}`
> + `active_store_access` + `has_pending_invitations` as *to-add* — **all three already ship.** That work
> is **done**, not pending.

---

## 3. Stores · device-access · context · hours

`StoreController`, `StoreDeviceController`, `StoreHoursController` (`modules/store/...`, `modules/store-hours/...`).

| Verb | Full path | Request | Response | Guards | Notes |
|---|---|---|---|---|---|
| POST | `/api/v1/stores` | `CreateStoreDto` | `StoreResponseDto` (201) | auth (no perm) | ✅ `max_stores` gate in service |
| GET | `/api/v1/stores/mine` | — | `StoreResponseDto[]` | auth | ✅ **owner-only** — never the store list (use `snapshot.stores[]`) |
| **POST** | **`/api/v1/stores/:storeId/open`** | — | `{ access, store_hours, sync_config, subscription, subscription_version, warnings }` | `Store:view` + `@SkipSubscriptionCheck` | ⚠️ **BUILT NOW** — mobile-07 Phase 4 / mobile-08 treat `/open` as future. It exists and is the one-call merged open. |
| POST | `/api/v1/stores/:storeId/access` | `StoreAccessDto {}` (empty) | `{access:'granted', isNew}` \| 403 `DEVICE_LIMIT_REACHED {limit, active, devices[]}` | `Store:view` | ✅ still exists (the two-call path) |
| GET | `/api/v1/stores/:storeId/context` | — | `StoreContextResponseDto {store, store_hours:{regular,special}, sync_config:{schema_version}}` | `Store:view` | ✅ |
| GET | `/api/v1/stores/:storeId` | — | `StoreResponseDto` | `Store:view` | 🆕 single-store fetch — not in mobile docs |
| PATCH | `/api/v1/stores/:storeId` | `UpdateStoreDto` | `StoreResponseDto` | `Store:edit` | 🆕 store edit — not in mobile docs |
| DELETE | `/api/v1/stores/:storeId` | — | 204 | `Store:delete` | 🆕 **archive** (sets `archivedAt`) — note: no `store.locked` field found; the downgrade-lock state (subscription S7/device F14) is **not yet a column** |
| GET | `/api/v1/stores/:storeId/devices` | — | `StoreDeviceListDto {meta:{limit,active,planName}, devices[]}` | `Device:view` | ✅ |
| POST | `/api/v1/stores/:storeId/devices/:deviceGuuid/revoke` | — | `{success}` | `Device:delete` | ✅ |
| PATCH | `/api/v1/stores/:storeId/devices/:deviceGuuid/label` | `{label}` | `{success}` | `Device:edit` | 🆕 store-scoped label — not in docs (docs only show user-level rename) |
| GET | `/api/v1/stores/:storeId/hours` | — | `{regular[], special[]}` | `Store:view` | ✅ |
| PUT | `/api/v1/stores/:storeId/hours/:dayOfWeek` | `{openTime?, closeTime?, isClosed?}` | day row | `Store:edit` | 🆕 edit hours — not in docs |
| GET/POST | `/api/v1/stores/:storeId/hours/special` | special-day | special[] / row | `Store:view`/`edit` | 🆕 special hours — not in docs |
| DELETE | `/api/v1/stores/:storeId/hours/special/:guuid` | — | 204 | `Store:edit` | 🆕 |

> ❌ **`DELETE /stores/:id/access` (release-on-logout, device §F10B.1 / §F10B.3) does NOT exist** —
> correctly marked 🆕 ADD in the device PRD. Confirmed missing; build it for slot-release + crash-reclaim.
> ❌ **`GET /stores` (plain accessible-store list) does NOT exist** — only `/stores/mine` (owner-only).
> mobile-04 §8E.2 lists a bare `/stores` route; correct that to "list via `snapshot.stores[]`".

---

## 4. User-level devices

`MyDevicesController` `@Controller('devices')` (`modules/store/controllers/store-device.controller.ts`).

| Verb | Full path | Request | Response | Notes |
|---|---|---|---|---|
| GET | `/api/v1/devices/my` | — | device[] incl. `stores:[{guuid,name}]` | ✅ (richer than `/me/devices`) |
| PATCH | `/api/v1/devices/:deviceGuuid/label` | `{label}` | `{success}` | ✅ |
| PATCH | `/api/v1/devices/:deviceGuuid/block` | — | `{success}` | ✅ (empty body — docs once showed `{reason}`; real takes none) |
| PATCH | `/api/v1/devices/:deviceGuuid/unblock` | — | `{success}` | ✅ |
| PATCH | `/api/v1/devices/:deviceGuuid/push-token` | `{pushToken}` | `{success}` | ✅ |

---

## 5. Sync

`SyncController` `@Controller('stores/:storeId/sync')` + `SyncConflictController`
(`modules/sync/controllers/...`). Class: `@SkipTransform` + `@RequirePermissions({entity:'Store',action:'view'})`.

| Verb | Full path | Request | Response | Throttle | Notes |
|---|---|---|---|---|---|
| GET | `/api/v1/stores/:storeId/sync/manifest` | — | `SyncManifestResult` (entity types + estimated counts) | 30/min | ⚠️ **BUILT NOW** — sync-engine §2/§6 mark manifest 🆕/Phase 6. Endpoint exists; the **enhanced fields** (`checksum`, `entity_version`, `minimum_client_version`, `latest_watermark`) are still proposals (current returns counts only). |
| GET | `/api/v1/stores/:storeId/sync/initial` | `?entity_type=&cursor=&reset=&supported_entity_types=` | `SyncInitialResponseDto` | 30/min, guard **exempt** | ✅ |
| GET | `/api/v1/stores/:storeId/sync/changes` | `?cursor=&supported_entity_types=` | `SyncChangesResponseDto {changes, sync_cursor, has_more}` | 60/min | ✅ |
| POST | `/api/v1/stores/:storeId/sync/delta` (200) | `SyncDeltaDto {sync_cursor?, mutations[], permissions_version?, supported_entity_types?}` | `SyncDeltaResponseDto` | 20/5min + **100 mutations/5min** | ✅; mutation result carries `conflict_type` (✅ typed-conflicts §11.1 already in DTO!) |
| GET | `/api/v1/stores/:storeId/sync/conflicts` | — | `ListSyncConflictsResponseDto` | — | ✅ |
| PATCH | `/api/v1/stores/:storeId/sync/conflicts/:mutationId` | `{status:'resolved'\|'discarded', note?}` | `SyncConflictResponseDto` | — | ✅ |

**Rate limiting (CORRECTED — both layers are per-store):**
- `SyncRateLimitGuard` key = **`sync_rate_limit:{userId}:{storeId}:{endpoint}`** ✅ per-(user,store,endpoint).
- `checkMutationRateLimit` key = **`sync_mutations:{userId}:{storeId}`** ✅ **includes storeId.**

> ⚠️ **The "per-user rate-limiter bug" is fully resolved in code.** sync-engine §16 item 2 / **S-6**,
> mobile-06 §8.5, mobile-07 **P0 #2 / Phase 0.1** all still describe `sync_mutations:{userId}` (no storeId)
> and a dead `/sync/pull` path as a *current bug*. Reality: **both limiters are per-`(user,store)`** and
> `/sync/pull` doesn't exist. Mark these **fixed**.

**Writable entity_types (MutationHandlerRegistry):** `customer, supplier, paymentaccount, lookup,
product, product_case` (6 types × CRUD = 18 handlers). ✅ matches the docs' gap statement — **no
`order`/`shift_session`/`cash_movement`/`stock_*` handlers** (the #1 gap). `SYNC_PAGE_SIZE = 200` ✅.

---

## 6. Subscription & billing

Three controllers: `SubscriptionController` (plans), `BillingController` (**store-scoped**
`/stores/:id/subscription`), `AccountSubscriptionController` (**account-scoped** `/me/subscription`),
plus a webhook. `user_subscription` **table exists** (migration `20260628_user_subscription.sql`).

| Verb | Full path | Request | Response | Notes |
|---|---|---|---|---|
| GET | `/api/v1/subscription/plans` | — | `SubscriptionPlanDto[]` | ✅ public-ish, cached 5min |
| GET | `/api/v1/subscription/plans/:code` | — | `SubscriptionPlanDto` | ✅ |
| GET | `/api/v1/me/subscription` | — | `AccountSubscriptionResponseDto {subscription{…, access_valid_until, cancel_at_period_end, banner_severity}, subscription_version}` + **`X-Subscription-Version` header** | ⚠️ **BUILT NOW** (account-level) |
| GET | `/api/v1/me/subscription/sv` | — | `{subscription_version}` + ETag `W/"acct-sv-<v>"` | ⚠️ **BUILT** — this is the real `sv` (docs' `/me/sv` is wrong) |
| POST | `/api/v1/me/subscription/cancel` | `{reason?}` | `{success}` | ⚠️ **BUILT** (account) — subscription.md S5 says "GAP: not built" — WRONG |
| POST | `/api/v1/me/subscription/reactivate` | — | `{success}` | ⚠️ **BUILT** (account) — subscription.md S6 says "GAP: not built" — WRONG |
| GET | `/api/v1/stores/:storeId/subscription` | — | `StoreSubscriptionResponseDto {subscription, subscription_version}` | ✅ store-scoped read |
| GET | `/api/v1/stores/:storeId/subscription/sv` | — | `{subscription_version}` + ETag | 🆕 store-scoped version poll — not in docs |
| POST | `/api/v1/stores/:storeId/subscription/checkout` | `{planCode}` | `CheckoutResponseDto` | ✅ **still store-scoped** (account checkout NOT built) |
| POST | `/api/v1/stores/:storeId/subscription/verify` | `{razorpayOrderId, razorpayPaymentId, razorpaySignature}` | `VerifyPaymentResponseDto` | ✅ store-scoped |
| POST | `/api/v1/webhooks/razorpay` | raw + `x-razorpay-signature` | `{}` | 🆕 webhook — not in docs |

**Freshness headers (BUILT):** `GET /me/subscription` sets **`X-Subscription-Version`**;
`SubscriptionStatusGuard` emits **`X-Subscription-Warning: past_due:grace_until_… / cancelled:ends_at_…`**.
**Error codes (lowercase, verified):** `subscription_payment_required` (402), `subscription_suspended`
(403), `subscription_feature_limit_reached` (403), **`subscription_lapsed_at_write` (402)**,
`subscription_not_found` (403).

> ⚠️ **Big stale finding.** subscription.md §9/§12/§13/§16/§27 and mobile-07 §10 say the account-level
> Hybrid subscription (`user_subscription`, `/me/subscription`, `subscriptionVersion`,
> `x-subscription-version`, `access_valid_until`) is a **GAP / target**. Reality: the `user_subscription`
> table, `GET /me/subscription` (+version header + `access_valid_until`), `/sv`, `cancel`, `reactivate`,
> and **`subscription_lapsed_at_write`** all **exist**. What's genuinely still store-scoped: **checkout +
> verify** (no `/me/subscription/checkout|verify`). So the device §30 offline write-gate is **partly
> built** already (the guard checks account `accessValidUntil` → `subscription_lapsed_at_write`).

---

## 7. RBAC · invitations · shifts · ownership transfer

`RbacController` `@Controller('stores/:storeId/rbac')`; `InvitationController` +
`InvitationResponseController`; `ShiftController`; `ShiftAssignmentController`; `OwnershipTransferController`.

**RBAC** (all `@RequirePermissions({entity:'Role',…})`; mutations add `@StepUpAuth({within:'5m'})`):
| Verb | Full path | Notes |
|---|---|---|
| GET | `/api/v1/stores/:storeId/rbac/entity-types` | 🆕 not in docs |
| GET | `/api/v1/stores/:storeId/rbac/roles` | 🆕 list — not in docs |
| POST | `/api/v1/stores/:storeId/rbac/roles` | ✅ (rota F1) — note **full** base path includes `/rbac` |
| PATCH | `/api/v1/stores/:storeId/rbac/roles/:roleId` | 🆕 rename/enable role — not in docs |
| DELETE | `/api/v1/stores/:storeId/rbac/roles/:roleId` | 🆕 |
| GET | `/api/v1/stores/:storeId/rbac/roles/:roleId/members` | 🆕 |
| GET | `/api/v1/stores/:storeId/rbac/roles/:roleId/permissions` | ✅ (rota F2) |
| PUT | `…/rbac/roles/:roleId/permissions/crud` | ✅ — docs shorthand omits `/stores/:storeId/rbac` prefix |
| POST | `…/rbac/roles/:roleId/permissions/special` | ✅ |
| DELETE | `…/rbac/roles/:roleId/permissions/special/:entityCode/:actionCode` | ✅ |
| PUT | `…/rbac/roles/:roleId/permissions/matrix` | ✅ |
| GET | `/api/v1/stores/:storeId/rbac/assignments/:userId` | 🆕 direct role-assignment API — not in docs |
| POST | `/api/v1/stores/:storeId/rbac/assignments` | 🆕 assign role to existing member (no invite) — not in docs |
| DELETE | `/api/v1/stores/:storeId/rbac/assignments/:assignmentId` | 🆕 |

**Invitations:**
| Verb | Full path | Notes |
|---|---|---|
| POST | `/api/v1/stores/:storeId/invitations` | ✅; **soft `USER_LIMIT_REACHED` pre-check at send IS built** (active+pending ≥ max) |
| GET | `/api/v1/stores/:storeId/invitations` | 🆕 list — not in docs |
| POST | `/api/v1/stores/:storeId/invitations/:invitationId/revoke` | ✅ (+step-up 5m) |
| GET | `/api/v1/invitations/:token` | ✅ `@Public` preview |
| POST | `/api/v1/invitations/:token/accept` · `/decline` | ✅; accept piggybacks `X-Permission-Snapshot*` headers |
| POST | `/api/v1/invitations/by-id/:invitationId/accept` · `/decline` | ✅ |

> ✅ **rota PRD confirmed:** accept checks **subscription** (`paused`/cancelled-past/past-due-no-grace) and
> **`max_users_per_store`** (authoritative re-check under row-lock at accept), but **NOT the device limit**
> — exactly as documented. The §15C S10 "GAP: not enforced today" is **stale — it IS enforced** (soft at
> send + authoritative at accept).

**Shifts (definitions + standing assignments):** all match the rota PRD ✅ —
`GET/POST/PATCH/DELETE /stores/:storeId/shifts` and `…/staff/:userId/shifts(/:assignmentId)`.

**Ownership transfer** (`OwnershipTransferController`, step-up gated) — 🆕 **not in the mobile docs**, and
subscription.md S9 references a single "accept"; the real flow is **4 steps**:
`POST …/ownership-transfer` (initiate) → `GET …/active` → `POST …/:id/confirm-recipient` →
`POST …/:id/finalize` (+ `PATCH …/:id/cancel`). subscription.md S9's `max_stores` pre-check is a real GAP.

> ❌ **Rota / service-area REST: NOT built** (tables `rota_entry`, `service_area`, `rota_template*` exist;
> no controller). ✅ matches rota PRD "schema-ready". ❌ **POS/order/shift_session/cash_movement REST:
> none** (sync-only). ✅ matches all docs.

---

## 8. Documented but NOT built (wrong / unnecessary)

| Documented in | Endpoint | Reality |
|---|---|---|
| mobile-01 §scale | `GET /me/snapshot?store=:id` | base `/me/snapshot` exists; **no `?store=`** (Phase-2 lever, unbuilt) |
| mobile-04 §8E.2 | `POST /me/active-store` | ❌ never built — use `PATCH /me/preferences` (the writer that exists) |
| mobile-04 §8E.2 | `GET /me/sv` | ❌ wrong path — real is **`/me/subscription/sv`** |
| mobile-04 §8E.2 | `/stores` (bare list) | ❌ no accessible-store list route — use `snapshot.stores[]`; only `/stores/mine` (owner-only) |
| mobile-04 §8E.2, mobile-01 | `/me/snapshot` under **Auth** domain | it's under **`/me`**, not `/auth` |
| subscription.md §9 | `POST /me/subscription/checkout` · `/verify` | ❌ not built — checkout/verify still **store-scoped** (`/stores/:id/subscription/checkout|verify`) |
| subscription.md §9/§14 | `POST /stores/:id/subscription/cancel` · `/reactivate` | ❌ moved to **account** (`/me/subscription/cancel|reactivate`) — store-scoped cancel/reactivate don't exist |
| device §F10B.1/.3 | `DELETE /stores/:id/access` | ❌ not built (release/crash-reclaim) — genuine 🆕 work |
| rota §10 | rota / service-area REST | ❌ not built (schema-ready) — genuine 🆕 work |
| auth docs / mobile-01 | `POST /auth/login` · `/auth/refresh` · `/auth/logout` | ⚠️ wrong prefix — real is **`/auth/mobile/login|refresh|logout`** |

---

## 9. Stale-doc corrections — the backend moved ahead

These are documented as **GAP / future / Phase-N / target** but are **already shipped**:

1. **`POST /stores/:storeId/open`** (merged access+context+subscription) — **BUILT.** (mobile-07 Phase 4,
   mobile-08, mobile-06 §8.3 still describe the two-call `/access`+`/context` as current and `/open` as
   future.) Both paths exist; prefer `/open`.
2. **Account-level subscription** — `user_subscription` table + `GET /me/subscription` (+ `access_valid_until`
   + `X-Subscription-Version`) + `/sv` + `cancel` + `reactivate` — **BUILT.** (subscription.md §16/§27,
   mobile-07 §10 call it a GAP.)
3. **`x-subscription-version` + `X-Subscription-Warning` headers** — **BUILT** (emitted by the account
   endpoint + `SubscriptionStatusGuard`). subscription.md §16 calls them target.
4. **`subscription_lapsed_at_write` (402)** — **BUILT** in `SubscriptionStatusGuard` (account
   `accessValidUntil` check). device §30 "Half B" server-side gate is partly in place already.
5. **Sync mutation limiter per-`(user,store)`** (`sync_mutations:{userId}:{storeId}`) — **FIXED.**
   sync-engine §16/S-6, mobile-06 §8.5, mobile-07 P0 #2 / Phase 0.1 still call it a per-user bug.
6. **Bootstrap `active_store {id,guuid}` + `active_store_access` + `has_pending_invitations`** — **PRESENT.**
   (mobile-02 §3c "ADD", mobile-07 §8a/Phase 0.2 "remaining work" — done.)
7. **`GET /sync/manifest`** — **BUILT** (counts-only). (sync-engine §2 "🆕 (add)", §6/Phase 6 "future".)
   Only the enhanced fields (checksum/entity_version/min_client_version) remain proposals.
8. **`max_users_per_store` gate at invite/accept** — **BUILT** (soft at send + authoritative at accept).
   subscription.md S10 / rota §17 #4 call it a GAP.
9. **Typed conflicts (`conflict_type`)** — the field is **already in `SyncDeltaResponseDto`** (rejected +
   conflict results). sync-engine §11.1 / S-18 propose it as 🆕 — the wire contract is present (verify the
   handlers populate it).

---

## 10. Per-doc fix list

Concrete edits to reconcile the PRDs with the verified backend:

| Doc | Fix |
|---|---|
| mobile-01 §1, mobile-04 §8E.2 | auth paths → **`/auth/mobile/login\|refresh\|logout\|step-up\|challenge`**; `/me/snapshot` is under `/me` not Auth; drop bare `/stores` |
| mobile-02 §3c | mark `active_store{id,guuid}` + `has_pending_invitations` as **shipped**, not "ADD" |
| mobile-04 §8E.2 | fix `/me/sv` → `/me/subscription/sv`; drop `POST /me/active-store` (use `PATCH /me/preferences`); add `/auth/mobile/*`, `/me/subscription/*`, `/stores/:id/open`, `/stores/:id/subscription[/sv]` |
| mobile-06 §8.2/§8.5, mobile-07 P0 #2 / Phase 0.1 | mark the sync rate-limiter **fixed** (both layers per-`(user,store)`; `/sync/pull` is dead comments) |
| mobile-07 §8a / Phase 0.2 | mark active-store object work **done** |
| mobile-07 Phase 4, mobile-08 §13, mobile-06 §8.3 | `/stores/:id/open` is **live** — present it as current, two-call as legacy |
| sync-engine §2/§6/§22 (S-6, S-18), §16 | manifest **exists** (counts); rate-limiter **fixed**; `conflict_type` **in DTO** |
| subscription.md §9/§12/§13/§16/§27, §23 BR, §25 R7 | account `/me/subscription` (+version header, `access_valid_until`, cancel, reactivate, `subscription_lapsed_at_write`) **shipped**; only **checkout/verify** remain store-scoped; S10 staff gate **built** |
| device §30 | server-side Half B (`subscription_lapsed_at_write`) **partly built** — confirm `client_modified_at` point-in-time path on `/sync/delta` vs the guard's request-time check |
| rota §17 #4 / subscription S10 | `max_users_per_store` gate **built** |
| (new) | document `POST /auth/mobile/signup`, `/otp/request`, `/challenge`, `/sessions[/revoke-others]`, `POST /webhooks/razorpay`, `/rbac/assignments*`, `/rbac/entity-types`, ownership-transfer 4-step, store-hours editing, `GET/PATCH/DELETE /stores/:id` |
