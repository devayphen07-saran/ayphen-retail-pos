# Ayphen Retail POS — Complete Implementation Reference

> **Stack:** Nx monorepo (pnpm) · NestJS backend (`apps/backend`) · Expo Router / React Native mobile (`apps/mobile`) · Drizzle ORM + Postgres · Redis · shared libs under `libs-common/*` and `libs-mobile/*`.
> **Scope:** The entire implemented system, backend and mobile, traced end to end. This is a faithful reference of the **current code** (read from source, every claim cites a file). Judgment/risks are confined to §14 (appendix), kept out of the descriptive sections.
> **Source of truth:** read directly from the codebase. Where a fact is inferred rather than confirmed, it is labelled.

**Important framing (confirmed from code):** the current schema and code implement **identity, auth/session, RBAC, subscription/billing, device management, stores/locations, invitations, and reference/lookup data**. The actual POS transactional domain — products, orders, customers, suppliers, inventory — **does not exist yet**: those tables were dropped in migration `0001` and never rebuilt, and the mobile POS/Products/Customers tabs are layout-only stubs with no API wiring. Treat "retail POS" here as the platform/account/subscription foundation, not the selling surface.

---

## 1. Overview

The system is a multi-tenant SaaS foundation for a retail POS product:

- **Accounts & tenancy** — an `account` (billing/tenant root) is owned by one `user` and contains one or more `stores`; each store has `locations` (with an immutable "Head Office" primary location).
- **Auth & session** — phone-OTP login/signup, HS256 JWT access tokens, rotating refresh tokens bound to an Ed25519 device key, Redis-backed blacklist/replay protection, and step-up (MFA) re-auth for sensitive actions.
- **RBAC** — entity×action CRUD grants plus special-action grants, composed into roles, resolved per (user, store) with a Redis cache and a JWT `pv`/DB `permissionsVersion` cache-bust mechanism; a signed permission "snapshot" delivered to the mobile client.
- **Subscription & billing** — plan catalog with entitlements/features, Razorpay-backed (or Fake-provider) checkout→verify→activate flow with transactional idempotency, a cron-driven lifecycle state machine, and a downgrade-reconciliation flow that blocks writes account-wide until the owner resolves over-limit resources.
- **Device management** — a per-(store,device) "slot" model that enforces `max_devices_per_store`, plus self-service device block ("stolen") and owner device removal.
- **Mobile app** — Expo Router file-based navigation across `(auth)`, `(onboarding)`, `(app)`, and `(store)/(tabs)` groups; Zustand for ephemeral session state; TanStack Query for server state; SecureStore for tokens/device key.

---

## 2. File Inventory (the completeness map)

### 2.1 Backend — business modules

**Auth core (`apps/backend/src/auth/core/`, `@Global()`):**
`auth-core.module.ts` (wires core providers, aliases `CORE_REDIS`→`MOBILE_REDIS` via `useExisting`), `core.tokens.ts` (`CORE_REDIS` token), `core-redis.provider.ts` (**dead** duplicate standalone provider — see §14), `auth-constants.service.ts` (typed TTL/limit getters), `crypto.service.ts` (JWT sign/verify HS256 via jose, snapshot HMAC, Ed25519 device-sig verify, SHA-256 hashing, canonical JSON), `password.service.ts` (Argon2id — present, unused by OTP flow), `msg91.service.ts` (SMS gateway — wired but disabled), `rate-limit.repository.ts` + `rate-limit.service.ts` (IP 5/min, phone-OTP limit), `audit.service.ts` (append-only `audit_logs`), `request-context.service.ts` (AsyncLocalStorage per-request context), `user-revocation-cache.service.ts` (5s soft-delete cache, fail-closed).

**Auth mobile (`apps/backend/src/auth/mobile/`):**
`mobile-auth.controller.ts` (`/auth/mobile/*`), `me.controller.ts` (`/me/bootstrap`, `/me/account-mode`), `mobile-auth.module.ts`. Guards: `guards/mobile-jwt.guard.ts`, `guards/subscription-status.guard.ts`. Interceptor: `interceptors/snapshot-refresh.interceptor.ts`. Mappers: `mappers/auth.mapper.ts`, `mappers/device.request-mapper.ts`, `mappers/session.mapper.ts`. Services: `auth-login.service.ts`, `auth-signup.service.ts`, `auth-logout.service.ts`, `otp.service.ts`, `otp-request.service.ts`, `refresh-token.service.ts`, `refresh-idempotency.service.ts`, `device.service.ts`, `device-challenge.service.ts`, `blacklist-cache.service.ts`, `replay-protection.service.ts`, `session-cache-invalidator.service.ts`, `snapshot.service.ts`, `step-up.service.ts`, `token-cleanup.service.ts`, `account-bootstrap.service.ts`, `redis.provider.ts` (`MOBILE_REDIS`). Repositories: `auth-session.repository.ts`, `device.repository.ts`, `otp-request.repository.ts`, `refresh-token.repository.ts`. DTOs under `dto/request/*` and `dto/response/*`. Types: `types/auth-result.ts`, `types/mobile-principal.ts`, `types/permission-snapshot.ts` (wire-exact snake_case, signed byte-for-byte).

**RBAC (`apps/backend/src/common/rbac/`, `@Global()`):**
`rbac.module.ts`, `rbac.service.ts`, `rbac.repository.ts`, `permission-matrix.constants.ts`, `permission-matrix.validator.ts`, `rbac-matrix.validator.service.ts`, `rbac-route.validator.service.ts`, `rbac-route-validator.module.ts`, `effective-permissions.ts`, `resolved-store-context.ts`, `decorators/rbac.decorators.ts`, guards: `tenant.guard.ts`, `permissions.guard.ts`, `location.guard.ts`, `super-admin.guard.ts`, `step-up-auth.guard.ts`.

**Subscription (`apps/backend/src/subscription/`):**
`subscription.module.ts`, `subscription.service.ts`, `billing.service.ts`, `reconciliation.service.ts`, `downgrade-detection.service.ts`, `entitlement.service.ts`, `subscription-reconciliation.service.ts` (cron), `subscription.repository.ts`, `subscription.mapper.ts`, `me-subscription.controller.ts`, `razorpay-webhook.controller.ts`, `subscription-cache.ts`, `plan-meta.ts`, `dto/subscription.dto.ts`, `dto/subscription.response.ts`, `dto/checkout.response.ts`, `payment/payment-provider.ts`, `payment/razorpay-payment.provider.ts`, `payment/fake-payment.provider.ts`, `payment/plan-pricing.ts`.

**Devices (`apps/backend/src/devices/`):**
`device-access.repository.ts`, `device-access.service.ts`, `device.mapper.ts`, `devices.module.ts`, `store-device.controller.ts` (`StoreDeviceController` + `StoreAccessController`), `my-device.controller.ts`.

**Stores / Locations (`apps/backend/src/stores/`, `apps/backend/src/locations/`):**
`stores/store.controller.ts|service.ts|repository.ts|mapper.ts`, `stores/dto/*`, `stores/role.controller.ts|service.ts|repository.ts|mapper.ts`, `stores/dto/role.*`, `stores/invitation.controller.ts|service.ts|repository.ts|mapper.ts`, `stores/dto/invitation.dto.ts`, `stores/stores.module.ts`. `locations/location.controller.ts|service.ts|repository.ts|mapper.ts`, `locations/dto/location.dto.ts`, `locations/user-location.repository.ts|service.ts`, `locations/locations.module.ts`.

**Reference/lookup (`apps/backend/src/`):**
`entity-types/*` (registry driving offline allow-list + attachments), `reference-data/*` (country/currency), `lookup/*` (user-extensible dropdown values).

### 2.2 Backend — cross-cutting infrastructure

**`common/` (excl. `rbac/`):** `exceptions/app.exception.ts`, `filters/http-exception.filter.ts` (`AllExceptionsFilter`), `interceptors/request-context.interceptor.ts`, `interceptors/response.interceptor.ts`, `interceptors/subscription-headers.interceptor.ts`, `middleware/request-id.middleware.ts`, `pipes/trim-string.pipe.ts`, `validation/parse.ts` (Zod helper), `request-ip.ts`, `db-context.ts`, `error-codes.ts`, `response-messages.ts`, `decorators/response-message.decorator.ts`, `decorators/validators.ts`, `pagination/{cursor,paginate,paginated-response}.ts`, `redis/redis.module.ts` (`@Global()`, provides `MOBILE_REDIS`).

**`db/`:** `db.module.ts` (`DRIZZLE` provider, `UnitOfWork`, `DbExecutor = Database | DbTransaction`), `create-pg-client.ts`, `audit.ts`/`audit.helpers.ts`, `reference.ts`, `rethrow-unique-violation.ts`, `schema.ts` (39 tables), `scripts/seed.ts`.

**`config/`:** `env.ts` (Zod-validated env, exits on invalid), `app-config.service.ts` (`razorpayConfigured` getter), `config.module.ts` (`@Global()`), `cors.config.ts`, `swagger.config.ts`.
**`bootstrap/apply-global-config.ts`** (shared prod+test global wiring), **`throttle/throttle.module.ts`** (100 req/min global), **`health/*`** (`GET /health` Terminus), **`logger/logger.module.ts`** (nestjs-pino), **`app/app.module.ts`** (root module graph).

### 2.3 Mobile

**Routes (`apps/mobile/src/app/`, Expo Router):** `_layout.tsx` (provider stack), `index.tsx` (auth gate). Groups: `(auth)/{_layout,phone,otp}.tsx`, `(onboarding)/{_layout,mode-select,create-store,invitations,onboarding-hub,personal}.tsx`, `(app)/{_layout,index,home,store-picker}.tsx`, `(store)/_layout.tsx` + `(store)/(tabs)/{_layout,index,pos,products,customer,more}.tsx` + store-stack screens (`locations`, `location-create`, `location-edit`, `roles`, `role-create`, `role-permissions`, `my-devices`, `more-detail`, `more-section`, `subscription`, `subscription-plans`, `subscription-checkout`, `downgrade-resolve`).

**Core (`apps/mobile/src/core/`):** `auth/token-store.ts` (SecureStore tokens), `auth/device-key.ts` (Ed25519 identity, SecureStore), `auth/device-request.ts`, `network/interceptors.ts` (axios attach/refresh), `providers/AuthProvider.tsx` (session lifecycle).

**Features (`apps/mobile/src/features/`):** `auth/` (authStore, schema, transform — wired), `onboarding/` (5 screens — wired), `store/` (largest; StoreEntry/Home/Picker, Locations CRUD, Roles CRUD, MyDevices, More, Subscription screens, `activeStore.ts`, `prefs.ts`, `useEnterStore.ts` — wired), `subscription/` (subscriptionStore, SubscriptionFreshnessWatcher, RazorpayCheckoutWebView — wired), `more/` (menu config — wired UI), `customers/`, `products/`, `pos/` (**layout-only stubs, no API**).

### 2.4 Shared libs

- `libs-common/api-manager/src/lib/<domain>/` — `api-data.ts` (route descriptors), `types.ts` (snake_case wire types), `tanstack-queries.ts` (hooks). Domains: `auth`, `devices`, `entity-types`, `invitation`, `locations`, `lookup`, `roles`, `store`, `subscription`. Core: `api-handler.ts` (`APIData`), `axios-instances.ts`.
- `libs-common/state-manager/src/index.ts` — **empty placeholder** (stores actually live in `apps/mobile/src/features/*`).
- `libs-common/shared-types/src/index.ts` — **empty placeholder** (types live in api-manager per-domain).
- `libs-mobile/mobile-theme/` — token system (color/sizing/borderRadius/borderWidth/shadow/typography), light+dark, `MobileThemeProvider`/`useMobileTheme`.
- `libs-mobile/mobile-ui-components/` — component library (AppLayout, Button, Tag, Chip, SegmentedTabs, BottomSheet system, GroupedMenu, ListRow, SearchBar, FlatListScaffold, Card, Divider, Typography, LucideIcon, CheckBox, MetricCard, SkeletonLoader, Alert, etc.).

### 2.5 Tests

`apps/backend/test/integration/` — `_smoke/{app-builder,di-isolation,nestfactory-boot,redis-provider,scaffold,symbol-identity}.spec.ts`, `auth/refresh-idempotency.spec.ts`, `devices/claim-slot-concurrency.spec.ts`, `entity-types/entity-types.spec.ts`, `lookup/lookup.spec.ts`, `subscription/{activate-from-payment,cancel-reactivate,reconcile-cancelled}.spec.ts`. `apps/backend/test/unit/auth/refresh-token-rotate.spec.ts`. Support: `test/setup/*` (testcontainers). **Mobile has no test infrastructure** (deps installed, nothing wired).

---

## 3. Data Model (39 tables, `apps/backend/src/db/schema.ts`)

Shared audit mixin (`db/audit.ts`): `createdAt`, `updatedAt`, `deletedAt` (null=active), `createdBy`, `updatedBy`, `deletedBy` — used by `stores`, `roles`, `files`, `notes`, `address`, `communication`, `contactPerson`.

### 3.1 Tenancy & identity
- **`accounts`** — `id` PK, `account_number` UNIQUE, `name`, `owner_user_fk`→users (owner authority = direct FK check, not RBAC), `gst_number`, `billing_address` jsonb, `razorpay_customer_id`.
- **`users`** — `id` PK, `guuid`, `email`/`phone` (each UNIQUE, nullable; at-least-one intended via a CHECK that is **not present** in schema/migrations — see §14), `name`, `phone_verified`, `primary_login_method` (otp/password/google), `permissions_version` (the `pv` source of truth), `status` (active/suspended/locked), `last_account_mode` (business/personal), `is_blocked`, `failed_login_attempts`, `account_locked_until`, `mfa_enabled`, `deleted_at` (soft delete).
- **`account_users`** — M:N accounts↔users membership. UNIQUE(account_fk, user_fk).
- **`stores`** — `account_fk`→accounts, `name`, tax/contact, `invoice_prefix`/`invoice_counter`, `is_active`, `locked`+`locked_reason` (enum `downgrade`), audit cols. Locked stores excluded from `max_stores` count.
- **`locations`** — `store_fk`→stores (cascade), `name`, `is_primary` (Head Office), `is_default`, `enable`, `is_active`, `display_order`, `locked`+`locked_reason`, `archived_at`. Partial unique: `uk_location_primary` (one primary/store), `uk_location_default` (one default/store), `uk_location_name` (unique `lower(name)` where active).
- **`user_location_mappings`** — `user_fk`, `location_fk`, `assigned_by`, `revoked_at` (soft). UNIQUE(user_fk, location_fk). No `store_fk` (derived via location).

### 3.2 RBAC
- **`roles`** — `store_fk` NULL = system-wide (`USER`, `SUPER_ADMIN`); `STORE_OWNER` is a system role that IS store-scoped. `code`, `name`, `is_editable`. CHECK `system_role_no_store`; unique system code where store_fk null; unique (store_fk, name).
- **`role_permissions`** — (role_fk, entity_code, action∈view/create/edit/delete), soft-deleted via `revoked_at` (enables point-in-time auth).
- **`role_special_permissions`** — (role_fk, entity_code, action_code SCREAMING_SNAKE), soft-deleted.
- **`user_role_mappings`** — (user_fk, role_fk, store_fk), `revoked_at`, `expires_at`. UNIQUE triple.
- **`entity_types`** — `code`, `label`, `is_offline_safe`, `supports_attachments` (drives offline allow-list; mirrors `ENTITIES` constant).

### 3.3 Subscription & billing
- **`plans`** — `name` UNIQUE (`free`/`starter`/`growth`), `display_name`, `is_active`.
- **`plan_entitlements`** — (plan_fk, key, value integer nullable). **null = unlimited; missing row = 0/blocked** (deliberate distinction). UNIQUE(plan_fk, key).
- **`plan_features`** — (plan_fk, key, enabled bool). UNIQUE(plan_fk, key).
- **`account_subscriptions`** — one per account (UNIQUE account_fk). `plan_fk`, `plan_code` (billing cadence, e.g. `starter_annual`, null pre-checkout), `status` (trialing/active/past_due/paused/cancelled/expired), `trial_ends_at`, `current_period_start/end`, `past_due_grace_until`, `access_valid_until` (stored, guard reads only this), `cancel_at_period_end`, `subscription_version` (bumped every mutation), `has_used_trial`, `razorpay_sub_id`, `reconciliation_status` (none/pending/applied), `reconciliation_effective_at`. CHECK `access_valid_until_required` (not null OR status=trialing).
- **`subscription_audit_outbox`** — transactional outbox (account_fk, event_type, payload jsonb, processed_at null=pending), partial pending index.
- **`processed_payment_events`** — `provider_ref` PK (idempotency), account_fk, order_id, processed_at.
- **`payment_orders`** — `order_id` PK, account_fk, plan_fk, plan_code (durable counterpart to 1h Redis `pay:order:` key).

### 3.4 Devices & sessions
- **`devices`** — `user_fk` (cascade), `public_key`+`public_key_hash`, `platform`, `is_trusted`, `is_blocked`, `label`, `push_token`. UNIQUE(user_fk, public_key_hash).
- **`device_sessions`** — `user_fk`, `device_fk`, `expires_at`, `last_step_up_at`/`last_step_up_method`, `step_up_locked_until`, `revoked_at`/`revoked_reason`, `current_jti`/`current_jti_exp` (for blacklisting live tokens).
- **`store_device_access`** — the slot: `store_fk`, `device_fk`, `user_fk`, `location_fk` (nullable), `status` (active/revoked/expired), `device_label`, `revoked_by`, `revoked_reason` (owner_removed/stolen/auto_expired/plan_downgrade/released). **Partial unique `uk_sda_active` (store_fk, device_fk) WHERE status='active'** = one active slot per (store, device).
- **`refresh_tokens`** — `device_session_fk`, `token_hash` UNIQUE (SHA-256), `parent_id` (self-ref chain), `family_id` (reuse-detection unit), `used_at` (non-null=rotated; CAS via `markUsed`), `revoked_at`/`revoked_reason`.
- **`otp_requests`** — `phone`, `purpose` (login/signup/step_up), `attempts`/`max_attempts`, `consumed_at`, `expires_at`.
- **`revoked_tokens`** — `jti` PK, `expires_at` (JWT blacklist durable fallback).
- **`login_attempts`** — rate-limit ledger (ip/user/email/phone/purpose/success), 4 composite indexes.
- **`audit_logs`** — append-only SOC2 trail (event, activity_type, prefix/suffix, user_id, actor_id, store_fk, is_success, entity_type/id, metadata jsonb).

### 3.5 Reference / polymorphic (largely scaffolding — see §14)
- **`country`** (ISO-3166), **`currency`** (ISO-4217), **`lookup_type`** + **`lookup`** (user-extensible dropdowns, global or store-scoped, `guuid` sync key), **`sequences`** (doc-number counters — seeded, not yet used).
- **Unused/scaffold tables** (defined, no app-code references): `invitation_locations`, `temporary_files`, `files`, `files_config`, `notes`, `address`, `communication`, `contact_person` — groundwork for a not-yet-built attachment/polymorphic-metadata feature.

### 3.6 Relationship spine
`accounts`(owner→users) → `stores`(account_fk) → `locations`(store_fk) → `user_location_mappings`. `accounts` → `account_subscriptions`(plan_fk→`plans`→`plan_entitlements`/`plan_features`), plus `subscription_audit_outbox`/`processed_payment_events`/`payment_orders`. `users` → `devices` → `device_sessions` → `refresh_tokens`; `store_device_access` bridges stores×devices×users×locations. RBAC subgraph rooted at `roles` (`role_permissions`, `role_special_permissions`, `user_role_mappings`). Polymorphic subgraph hangs off `entity_types` + `lookup`.

---

## 4. Flows (end to end, cross-layer)

### 4.1 Login / Signup
1. **Stage 1 (request OTP)** — mobile `phone.tsx` → `POST /auth/mobile/login/otp` (or `signup/otp`). `AuthLoginService.loginStageOne`: login requires existing user (401 `NOT_FOUND` else); `OtpRequestService.requestOtp` does IP+phone rate limits, a per-phone Redis `otp_lock:{phone}:{purpose} NX EX 5` to collapse duplicates, resend cooldown, inserts `otp_requests`, `OtpService.generateAndSend` (6-digit code → Redis `dev_otp:{phone}`, **console-logged; MSG91 disabled**). Returns `{otp_sent, otp_request_id, expires_in}`.
2. **Stage 2 (verify + issue)** — mobile `otp.tsx` builds the device payload (`buildDeviceRequest()` → `getDevicePublicKey()` lazily generates+persists the Ed25519 key in SecureStore) → `POST /auth/mobile/login/verify`. `AuthLoginService.loginStageTwo`: IP limit, `findActiveRequest` (422 `OTP_EXPIRED`), account-lock check (429), `OtpService.verifyOtp` (timing-safe compare, increments attempts, marks consumed). On failure: atomic CAS increment of `failed_login_attempts`, locks account at threshold. On success, one `UnitOfWork` transaction: reset lock counters + `phoneVerified=true`; `DeviceService.upsertDevice` (find by `(userFk, sha256(publicKey))`, else insert untrusted device); `AuthSessionRepository.create` (new `device_sessions`); `RefreshTokenService.issueRefreshToken` (48-byte random, SHA-256 stored, new `familyId`). Post-tx: `CryptoService.signJwt` (HS256, claims `{type:'access', deviceSessionId, pv}`); audit `LOGIN_SUCCESS`. Returns `LoginResponse` (`access_token`, `refresh_token`, `user{id,permissions_version}`, `is_new_user`, `device_id`, `device_session_id`, `is_trusted`).
3. **Signup** mirrors login but stage 2 also runs `AccountBootstrapService.bootstrap`: creates `accounts` (owner = new user, `ACC-XXXXXX`), `account_users`, and an `account_subscriptions` row on `free`/`trialing` with **no trial window yet** (clock starts at first store creation). Phone-uniqueness race normalized (`23505` → `USER_ALREADY_EXISTS`).
4. **Mobile completion** — `AuthProvider.login(res)` saves tokens to SecureStore, hydrates `authStore`, fires `/me/bootstrap` + last-opened-store hydration in parallel, routes to `(app)`. `(app)/index.tsx` (**AppGate**) then routes by state: no `lastAccountMode`→mode-select; `personal`→personal; no stores→onboarding-hub; no active store→store-picker; else→home.

### 4.2 Refresh rotation (with idempotency)
1. Mobile `interceptors.ts` `runRefresh()` (single-flight): `POST /auth/mobile/refresh/challenge` (validates token, issues `device_challenge:{id}→deviceId` in Redis, does **not** rotate) → `signChallenge(challengeId)` via device key → `postRotationWithRetry` `POST /auth/mobile/refresh` with `{refresh_token, challenge_id, device_signature, snapshot_version}`.
2. `RefreshTokenService.rotate`: `RefreshIdempotencyService.claim(sha256(token))` — Redis `SET NX EX 60`:
   - **leader** → `performRotation`.
   - **cached** → returns the stored result verbatim (retry-safe for flaky networks).
   - **timed_out** (another rotation still pending after a 3s poll) → throws `503 REFRESH_IN_PROGRESS_RETRY`. **This is the critical fix** — falling through would make the race-loser fail the CAS and be treated as reuse, wrongly revoking the family.
3. `performRotation`: reuse check (`used_at` set → `revokeFamily('reuse_detected')` + throw `REFRESH_TOKEN_REUSE`); validate token/session/user; **device-binding proof** (consume one-time challenge via `GETDEL`, must map to the session's `deviceFk`; Ed25519 verify); sign new JWT; atomic CAS `markUsed(id) WHERE used_at IS NULL RETURNING id` (only one racer wins — loser revokes family inside the same tx then throws); insert new refresh row (same `familyId`, `parentId`=old); update session `currentJti`. Post-commit: blacklist old JWT, invalidate session cache. `SnapshotService.getOrBuild(userId, snapshotVersion)` returns `null` if unchanged.
4. Mobile retries `refresh_in_progress_retry` up to 3× (400ms·attempt backoff); other errors rethrow. On success saves tokens, updates snapshot, retries the original 401'd request once.

### 4.3 Checkout → payment → activation
1. `SubscriptionPlansScreen` → confirm sheet → `/(store)/subscription-checkout?planCode=`.
2. `SubscriptionCheckoutScreen` → `POST /me/account/subscription/checkout {plan_code}`. `BillingService.checkout`: owner gate (no step-up), resolve `PLAN_PRICING`+plan id, `PaymentProvider.createOrder` (Razorpay REST or Fake; gateway failure → 503), durably insert `payment_orders` **before** the 1h Redis `pay:order:{id}` key, return client payload + prefill.
3. `RazorpayCheckoutWebView` renders hosted `checkout.js`; success → `POST /me/account/subscription/verify {order_id, payment_id, signature}`.
4. `BillingService.verify`: ownership, `PaymentProvider.verifyPayment` (HMAC-SHA256, `timingSafeEqual`), `applySuccess(orderId, providerRef)`.
5. `applySuccess` (shared with webhook): Redis `SET pay:done:{orderId} NX EX 86400` (fast-path only); `readOrder` (Redis→`payment_orders` fallback); `SubscriptionService.activateFromPayment`; on **any** failure releases the `pay:done` claim so retries can still succeed.
6. `activateFromPayment` (true idempotency boundary): one tx — `claimPaymentEvent` inserts `provider_ref` into `processed_payment_events` (PK) `ON CONFLICT DO NOTHING`; if already claimed → total no-op (no second version bump/outbox). Else `applyTransition` (`active`, planFk/planCode, period = now+30d, accessValidUntil=periodEnd). Then `DowngradeDetectionService.isOverLimit`: if over → `reconciliation_status='pending'` (blocks writes); else if a prior downgrade left `reconciliation_status !== 'none'` → `ReconciliationService.autoRestore` (exact unlock/restore).
7. **Webhook backstop** — `POST /webhooks/razorpay` (`@Public()`, HMAC over raw body) → same `applySuccess` path, so a retried verify and a redelivered webhook can never double-activate.

### 4.4 Downgrade reconciliation
- Detection: only in `activateFromPayment` (every plan switch funnels here). Sets `reconciliation_status='pending'` when the new plan is over limit on any axis (stores account-wide; locations/devices per-store).
- Guard: `SubscriptionStatusGuard` blocks all writes with `SUBSCRIPTION_RECONCILIATION_REQUIRED` while pending (reads always pass); the reconciliation controller is deliberately outside that guard so it can clear the state.
- Resolve: `DowngradeResolveScreen` fetches `GET /me/subscription/reconciliation` (live snapshot of stores/locations/devices + limits), pre-seeds a default keep-set (current device's store forced in), owner adjusts, `POST /me/subscription/reconciliation {keep_*_ids}` (owner + step-up). `ReconciliationService.apply` (one tx): **`lockAccount` first**, `validate` (server re-checks all ids/counts; current device can never be dropped — checked against **all** devices, incl. by-whole-store exclusion), lock non-kept stores, lock non-primary non-kept locations in kept stores, revoke non-kept device slots (`plan_downgrade`), set `reconciliation_status='applied'`, enqueue outbox.
- Restore: on a later covering upgrade, `autoRestore` unlocks/reactivates everything (nothing was deleted). `swapActiveStoreForUser` (`POST /me/subscription/active-store`) lets the owner swap which locked store is active — **backend only, no mobile UI**.

### 4.5 Device slot claim
1. `StorePickerScreen`/`StoreEntryScreen` → `useEnterStore.enterStore` → `POST stores/:storeId/access` (guards: JWT, Tenant, SubscriptionStatus; **no** `@RequirePermissions` — any member may claim).
2. `DeviceAccessService.claimSlot`: if `findActiveSlot` exists → `touchSlot` heartbeat, return `{granted, isNew:false}` (no entitlement re-check). Else one tx: **`lockStore` (SELECT…FOR UPDATE)** → `countActiveSlots` → `canCreate(limit, active)` (null=unlimited); over → `403 DEVICE_LIMIT_REACHED {limit, active, devices[]}`; else `insertSlot`. Partial unique `uk_sda_active` is the final backstop (`23505` caught as idempotent re-claim).
3. Mobile: success → `setActiveStore` + `router.replace('/(store)')`; `device_limit_reached` → alert + redirect to store-picker; other error → retryable alert.

### 4.6 Store / Location / Invitation creation
- **Store** (`POST /stores`, JWT only, `@StoreContext('none')`): owner gate → fast max_stores pre-check → tx: **`lockAccount`** → re-check → insert store → create immutable `STORE_OWNER` role + seed full grant matrix + assign creator → **insert Head Office** (primary+default) → **startTrial** if first store & trialing & !hasUsedTrial (15-day window) → bump `permissions_version`. Post-tx: invalidate store cache + **snapshot**. Mobile awaits `refetchUser()` before navigating (snapshot must refresh or the gate bounces).
- **Location** (`POST stores/:storeId/locations`): fast pre-checks (max_locations w/ Head Office as slot 1; name uniqueness) → tx: **`lockStore`** → re-check → insert → clear other defaults if default → assign creator to the location. Head Office/default disable/delete rules enforced in `updateLocation`/`deleteLocation`.
- **Invitation** create (`POST stores/:storeId/invitations`, `@RequirePermissions(Invitation.create)`): contact required; role must be custom; no duplicate pending; fast max_users pre-check → tx: **`lockStore`** → re-check → insert token (`randomBytes(24).base64url`, 7-day TTL). **Delivery not wired.** Accept (`POST /invitations/accept`, JWT only — token carries store): rate-limit, lookup/pending/expiry checks → tx: **CAS `markAccepted` WHERE status='pending'** (race guard, checked before side effects) → membership + role + version bump. Reject mirrors with `markRevoked`.

---

## 5. Business Rules (statement · enforcement)

| Rule | Enforced |
|---|---|
| OTP TTL / max attempts / resend cooldown | `OtpService.verifyOtp`, `OtpRequestService.requestOtp` |
| IP rate limit (5/min), phone-OTP limit | `RateLimitService` |
| Account lockout after N failed logins | `AuthLoginService.handleFailedOtp` (CAS increment + lock) |
| Refresh reuse → revoke whole family | `RefreshTokenService.performRotation` (`used_at` + CAS `markUsed`) |
| Device-binding proof mandatory on refresh (unless trusted) | `performRotation` (one-time challenge bound to session `deviceFk` + Ed25519) |
| Refresh idempotency (no false reuse from retries) | `RefreshIdempotencyService` leader/cached/timed_out |
| JWT blacklist on logout/revoke/rotation | `BlacklistCacheService` (LRU→Redis→`revoked_tokens`) |
| Replay protection (nonce + ±30s timestamp) | `ReplayProtectionService` in `MobileJwtGuard` |
| Step-up recency window / rate-limit + session lock | `StepUpAuthGuard`, `StepUpService` |
| `pv` (JWT) vs `permissions_version` (DB) mismatch → cache bust | `PermissionsGuard.canActivate` (H-6) |
| System-wide roles never contribute store grants | `RbacService.resolveFromDb` (`roleStoreFk === storeId`) |
| Guard chain must resolve a store before permission/step-up/location checks | `RbacRouteValidatorService` (boot-time) |
| Missing vs inaccessible store indistinguishable (timing-oracle) | `TenantGuard` uniform 404 |
| Entitlement: strict `current < limit`; null=unlimited; **missing row = 0** | `EntitlementService.get`/`canCreate` |
| Only account owner creates stores; max_stores race-safe | `StoreService.createStore` + `lockAccount` |
| max_locations (Head Office = slot 1); name unique/store | `LocationService` + `lockStore` + `uk_location_name` |
| Head Office cannot be disabled/deleted; immune to downgrade-lock | `LocationService`, `LocationRepository.lockMany` |
| Exactly one Head Office / one default per store | DB `uk_location_primary`, `uk_location_default` |
| Only custom roles invitable/assignable; system roles immutable | `InvitationService`/`RoleService` (`SYSTEM_ROLE_CODES`) |
| max_users (distinct active-role users); race-safe | `InvitationService.create` + `lockStore` |
| Invitation TTL 7d; accept/reject CAS on `status='pending'` | `InvitationRepository.markAccepted`/`markRevoked` |
| Payment activation idempotent (verify + webhook) | `processed_payment_events` PK claim in tx |
| Checkout/verify owner-only (no step-up); cancel/reactivate/reconcile/swap require step-up 5m | `me-subscription.controller.ts` `@StepUpAuth` |
| Subscription write-gate: suspended/expired/lapsed/reconciliation-pending/store-locked | `SubscriptionStatusGuard` (reads always pass) |
| First-store trial starts once (`has_used_trial`) | `StoreService.createStore` |
| One active device slot per (store, device); max_devices race-safe | `uk_sda_active` + `claimSlot` + `lockStore` |
| Cannot remove your own current device; block/unblock ownership-checked | `DeviceAccessService.removeDevice`/`blockDevice` |
| Downgrade resolve: server re-validates all ids/counts; current device never dropped | `ReconciliationService.validate` + `apply` `lockAccount` |

---

## 6. API Contract (selected; full per-module tables in the research appendices)

**Auth (`/auth/mobile/*`, `/me/*`):** `login/otp`, `login/verify`, `signup/otp`, `signup/verify`, `refresh/challenge`, `refresh` (public), `logout`, `logout-all`, `sessions` (list/revoke), `step-up/{challenge,otp,verify}`, `me/bootstrap`, `me/account-mode`.

**Subscription (`MeSubscriptionController`, JWT + class-wide `StepUpAuthGuard` no-op unless `@StepUpAuth`, `@StoreContext('none')`):**

| Method | Path | Auth | Idempotency |
|---|---|---|---|
| GET | `/me/subscription/plans` | JWT | read (static, 24h client cache) |
| GET | `/me/subscription` | JWT | read |
| GET | `/me/subscription/sv` | JWT | read |
| POST | `/me/account/subscription/checkout` | JWT + owner | Razorpay receipt-hash dedupe |
| POST | `/me/account/subscription/verify` | JWT + owner | full (Redis + `processed_payment_events`) |
| POST | `/webhooks/razorpay` | `@Public()` HMAC | same as verify |
| POST | `/me/subscription/cancel` | JWT + owner + step-up | no-op if already pending |
| POST | `/me/subscription/reactivate` | JWT + owner + step-up | no-op if nothing pending |
| GET | `/me/subscription/reconciliation` | JWT + owner | read |
| POST | `/me/subscription/reconciliation` | JWT + owner + step-up | re-validated |
| POST | `/me/subscription/active-store` | JWT + owner + step-up | row-locked (no mobile UI) |

**Plan catalog shape (current):** one entry per plan — `{plan_name, display_name, display_order, is_recommended, short_description, feature_highlights[], pricing: [{plan_code, billing_cycle, amount, currency, savings_percentage}], entitlements, features}`. `free` has empty `pricing[]`.

**Devices:** `POST stores/:storeId/access` (claim, any member), `GET/DELETE stores/:storeId/devices[/:id]` (owner, `Device:view/delete`), `GET devices/my`, `PATCH devices/:id/block|unblock` (JWT only).

**Stores/RBAC/Locations/Invitations:** `POST /stores`; `GET/POST/PATCH/DELETE stores/:storeId/roles[...]` (+assign/members); `POST stores/:storeId/invitations`, `POST /invitations/{accept,reject}`, `GET /me/invitations`; `GET/POST/PATCH/DELETE stores/:storeId/locations[...]` (+users sub-routes, `@LocationContext`); `GET /entity-types`.

**Guard chain (canonical, per protected controller):** `MobileJwtGuard → TenantGuard → [LocationGuard] → PermissionsGuard → SubscriptionStatusGuard`. Only `ThrottlerGuard` is global (`APP_GUARD`).

---

## 7. Mobile Implementation

- **Provider stack** (`app/_layout.tsx`): `GestureHandlerRootView → SafeAreaProvider → MobileThemeProvider → BottomSheetProvider → QueryClientProvider (retry 2, staleTime 5m, gcTime 10m) → AuthProvider → SubscriptionFreshnessWatcher + RootNavigator`. `BootstrapLoader` overlays until fonts + auth ready.
- **Routing gates:** each group `_layout.tsx` redirects by auth/store state; `(app)/index.tsx` (AppGate) is the post-login router; `(store)/_layout.tsx` requires `activeStore.storeId` or redirects to store-picker.
- **State:** three plain Zustand stores in `features/*` (no persist middleware) — `authStore` (session flags, user, snapshot, invitation counts), `activeStoreStore` (`store`/`storeId`), `subscriptionStore` (freshness bookkeeping only; payload lives in Query cache). `state-manager`/`shared-types` libs are empty scaffolds.
- **Storage:** tokens + device private key in **SecureStore** (`expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`); last-opened store id in AsyncStorage; everything else ephemeral.
- **Networking:** `interceptors.ts` attaches bearer + `x-nonce`/`x-timestamp` (skips public paths), learns server clock offset from the response envelope, single-flight refresh on 401, observes `X-Subscription-Version`/`Warning` into `subscriptionStore`.
- **Path aliases:** `@core/*`, `@features/*`, `@ui/*` in `tsconfig.app.json`, mirrored by a custom `resolver.resolveRequest` in `metro.config.js` (Metro has no native alias).
- **Wired vs stub:** wired — auth, onboarding, store (locations/roles/devices/subscription), more. **Stubs (layout-only, no API): customers, products, pos.**

---

## 8. Sync & Offline

Not yet built. `api-manager/CONVENTIONS.md` documents the intent: entity writes (products/orders/customers) should go through a sync-queue engine, not api-manager — matching the stub status of the POS/Products/Customers tabs and the absence of product/order tables. `entity_types.is_offline_safe`, the point-in-time RBAC auth (`wasCrudAuthorizedAt`), and `reconciliation_effective_at` are the groundwork; no offline queue/cursor/applier exists in code today. `@OnlineOnly` decorator + `X-Client-Mode: offline_replay` handling exist server-side as forward-looking hooks.

---

## 9. Seed & Reference Data (`db/scripts/seed.ts`, idempotent, `pnpm db:seed`)

- **Roles:** system-wide `USER`, `SUPER_ADMIN` (both `is_editable:false`, `store_fk:null`). `STORE_OWNER` is NOT seeded — created per-store.
- **Plans:** `free` (stores 1 / loc 1 / dev 1 / users 1 / products 100; offline_mode only), `starter` (1/3/5/10/2000; +barcode +multi_store), `growth` (unlimited except devices 20; all features). No `enterprise` seeded.
- **Entity types:** from `ENTITIES` constant.
- **Lookups:** 19 system lookup types (PAYMENT_TERMS, CUSTOMER_TYPE, REASONS, BUSINESS_CATEGORY(10), STATE(36 GST codes), etc.).
- **Reference:** 40 countries (ISO-3166 + calling codes), 32 currencies (ISO-4217 + symbols).
- **Sequences:** `order`/ORD, `refund`/REF, `adjustment`/ADJ (seeded, not yet consumed).

---

## 10. Dependencies & Coupling

- **Root module graph** (`app.module.ts`): `AppConfigModule, LoggerModule, DbModule, HealthModule, ThrottleModule, ScheduleModule, RedisModule, AuthCoreModule, RbacModule, MobileAuthModule, StoresModule, SubscriptionModule, DevicesModule, LocationsModule, EntityTypesModule, LookupModule, ReferenceDataModule, RbacRouteValidatorModule` (last — validates routes after all controllers wire).
- **Global wiring** (`bootstrap/apply-global-config.ts`, shared prod+test): Express hardening, 30s timeout, CORS, body parsers (with raw-body capture for webhook HMAC), `api` prefix, `AllExceptionsFilter`, `TrimStringPipe`+`ValidationPipe`, interceptors `RequestContext → SubscriptionHeaders → Response`.
- **Cross-module couplings:** Devices → Subscription (`EntitlementService`) + Auth (guards); Subscription ↔ Stores/Locations/Devices (reconciliation locks/revokes); Stores → RBAC (seed owner grants) + Subscription (startTrial); every mutating store-scoped route → the full guard chain. `SubscriptionStatusGuard` lives in `auth/mobile/guards` but gates all business modules.
- **Payment provider:** `PAYMENT_PROVIDER` bound via factory in `subscription.module.ts` — `config.razorpayConfigured ? Razorpay : Fake` (Fake used whenever any of the 3 Razorpay env vars is missing).
- **Redis:** single physical connection; `MOBILE_REDIS` (provided by `common/redis/redis.module.ts`) aliased as `CORE_REDIS` (`useExisting`) in `AuthCoreModule`.

---

## 11. Testing

- **Backend:** Jest + ts-jest, one shared Postgres+Redis pair via testcontainers (`test/setup/global-setup.ts`, migrated once, handed off via temp file; `maxWorkers:1`; per-test truncation in `after-env.ts`). Specs: smoke (app-builder, di-isolation, nestfactory-boot, redis-provider, scaffold, symbol-identity), auth (refresh-idempotency), devices (claim-slot-concurrency), subscription (activate-from-payment, cancel-reactivate, reconcile-cancelled), entity-types, lookup; unit (refresh-token-rotate). Run via `nx test @ayphen/backend` (and npm scripts `test:unit`/`test:integration`; `test:e2e` references a non-existent dir).
- **Mobile:** **no test infrastructure** (`@testing-library/react-native`+`jest-expo` installed but no config, no specs, no target).
- **CI:** `.github/workflows/ci.yml` — push to main + all PRs → `nx run-many -t lint test build typecheck e2e` (Nx Cloud, 3 agents). Backend Jest runs under the generic `test` target; testcontainers rely on Docker on the GitHub runner.

---

## 12. Config & Feature Flags

- `config/env.ts` — Zod-validated env, exits on invalid; covers DB/Redis URLs, JWT secrets/TTLs, OTP/step-up/lockout constants, MSG91, Razorpay keys (all optional), body limits, cron expressions.
- Payment provider selection: `AppConfigService.razorpayConfigured` (all 3 Razorpay vars set).
- Cron cadences: `CRON_SUBSCRIPTION_RECONCILIATION` (reconcile + outbox drain, Redis-locked `SET NX EX 900`), `CRON_TOKEN_CLEANUP` (revoked-token sweep).
- No runtime feature-flag system beyond `plan_features` (per-plan capability booleans) and env.

---

## 13. Open Questions / Not Found

- **`users` email-or-phone CHECK** — referenced in a comment but not present in `schema.ts` or any migration; either applied out-of-band or stale.
- **POS domain** — no products/orders/customers/suppliers/inventory tables or endpoints exist (dropped in `0001`). The mobile POS/Products/Customers tabs are stubs.
- **Offline sync engine** — documented as intended, not implemented.
- **`swapActiveStoreForUser`** — backend + tests exist; no mobile consumer.
- **Invitation/OTP delivery** — records + tokens generated, but SMS/email/push delivery not wired (MSG91 disabled; invitation delivery TODO).
- **7 polymorphic/attachment tables + `sequences` + `invitation_locations`** — schema/migration groundwork, no application code.
- **`auto_expired` / `released` device revoke reasons** — in the enum, no trigger path.

---

## 14. Appendix — Findings & Risks (kept separate from the reference above)

These are the notable correctness/health items surfaced during discovery. Several were fixed earlier in the current work session (noted inline).

1. **`di-isolation.spec.ts` is a live failing/incorrect test** — it compiles `[DbModule, AuthCoreModule]` and resolves `CORE_REDIS`, but `CORE_REDIS` is `{provide: CORE_REDIS, useExisting: MOBILE_REDIS}` and `MOBILE_REDIS` is only provided by `RedisModule`, which the test never imports. `@Global()` does not pull an absent module into an isolated compile. **Confirmed still present/unfixed.**
2. **Duplicate `CoreRedisProvider` landmine** — `auth/core/core-redis.provider.ts` exports a second provider with the same name as the inline `useExisting` one in `auth-core.module.ts`; it's dead code and easy to import by mistake.
3. **Reconciliation bugs — fixed this session:** (a) `ReconciliationService.apply()` now takes `lockAccount` first (was racing `apply`/`swap`); (b) `validate()`'s self-lockout check now runs against all devices incl. whole-store exclusion (was only checking devices inside kept stores); mobile `DowngradeResolveScreen` now forces the current device's store into the default keep-set and disables its checkbox.
4. **Device slot TOCTOU — fixed earlier:** `claimSlot` takes `lockStore` before `countActiveSlots`.
5. **Payment idempotency — fixed earlier:** transactional `processed_payment_events` claim; `applySuccess` releases the Redis `pay:done` claim on any failure.
6. **Refresh rotation false-reuse — fixed earlier:** `RefreshIdempotencyService` tri-state (`timed_out` → 503 retry, never falls through to a losing CAS).
7. **Snapshot signing** is HMAC-SHA256 (documented placeholder for Ed25519) — don't over-claim asymmetric security.
8. **OTP + invitation delivery disabled** — every environment uses the dev console-log OTP path; a pre-production gap.
9. **Cron `planFk` coupling** — downgrade detection is wired only into `activateFromPayment`. The four cron status transitions never touch `planFk` today (safe), but nothing enforces that; a future change resetting `planFk` (e.g. cancelled→free) without a paired `isOverLimit` check would silently blow past limits.
10. **`swapActiveStoreForUser` unreachable** — decide: build the mobile screen or remove the endpoint.
