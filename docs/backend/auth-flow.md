# Backend Authentication Flow — Complete Deep Dive

A complete reference for every service, repository, guard, interceptor, schema, and constant that participates in authentication. Covers mobile JWT auth, web cookie auth, token rotation, device management, OTP, step-up, snapshots, and security hardening layers.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Database Schemas](#2-database-schemas)
3. [Auth Constants](#3-auth-constants)
4. [Mobile Auth — OTP Login/Signup Flow](#4-mobile-auth--otp-loginsignup-flow)
5. [Mobile Auth — Token Refresh Flow](#5-mobile-auth--token-refresh-flow)
6. [Mobile Auth — JWT Guard (Request Authentication)](#6-mobile-auth--jwt-guard-request-authentication)
7. [Mobile Auth — Logout & Session Management](#7-mobile-auth--logout--session-management)
8. [Mobile Auth — Step-Up Authentication](#8-mobile-auth--step-up-authentication)
9. [Snapshot System](#9-snapshot-system)
10. [OTP System](#10-otp-system)
11. [Device Management](#11-device-management)
12. [Security Layers](#12-security-layers)
13. [Web Auth — BetterAuth Cookie Sessions](#13-web-auth--betterauth-cookie-sessions)
14. [Web Auth — Step-Up (OTP-SMS)](#14-web-auth--step-up-otp-sms)
15. [Core Services](#15-core-services)
16. [Module Wiring](#16-module-wiring)
17. [Error Reference](#17-error-reference)
18. [Improvements Adopted from Ayphen 3.0](#18-improvements-adopted-from-ayphen-30)
    - [18.1 Typed MobilePrincipal](#181-typed-mobileprincipal--replacing-untyped-requser)
    - [18.2 RequestContextService (AsyncLocalStorage)](#182-requestcontextservice--asynclocalstorage-equivalent-of-usercontextholder)
    - [18.3 Token Type Enforcement](#183-token-type-enforcement-in-mobilejwtguard)
    - [18.4 accountLockedUntil on OTP Failures](#184-accountlockeduntil-enforcement-on-otp-failures)
    - [18.5 Email Verification for Web](#185-email-verification-for-web-registration)
    - [18.6 Forgot/Reset Password](#186-forgot-password--reset-password-web-track)
    - [18.7 Refresh Token in HTTP-Only Cookie](#187-refresh-token-in-http-only-scoped-cookie-web-track)
    - [18.8 Password Reset Invalidates All Sessions](#188-password-reset-invalidates-all-sessions)
    - [18.9 phoneVerified Flag Set on OTP Login](#189-phoneverified-flag-set-on-otp-login)
    - [18.10 Transparent Password Rehash](#1810-transparent-password-rehash-on-login)
    - [18.11 Structured Error Code Naming](#1811-structured-error-code-naming-convention)
    - [18.12 StoreGuard — Tenant Isolation](#1812-storeguard--uniform-tenantstore-isolation)
    - [18.13 Activity Log Templates](#1813-activity-log-prefixsuffix-template-system)
    - [18.14 Account Status Guard Checklist](#1814-isverified--account-status--complete-guard-enforcement-checklist)
    - [18.15 Async Email Queue](#1815-async-email-queue-for-web-auth-emails)
    - [18.16 Swagger Bearer Scheme](#1816-swagger--openapi--bearer-security-scheme)
    - [18.17 Implementation Priority](#1817-implementation-priority)

---

## 1. Architecture Overview

### Two parallel auth tracks

```
Mobile Clients                            Web Clients (Dashboard)
     │                                          │
     ▼                                          ▼
POST /auth/mobile/*                      /auth/web/* (BetterAuth)
     │                                          │
MobileJwtGuard                          WebSessionGuard
(JWT Bearer + device binding)           (Cookie session)
     │                                          │
Permission Snapshot                     Step-up gate (OTP-SMS)
(offline-capable, signed)               (for sensitive actions)
```

**Mobile track**: stateless JWT access tokens + rotating refresh tokens, bound to a specific device. Permissions are embedded in a signed snapshot cached in Redis and on-device.

**Web track**: stateful BetterAuth cookie sessions (60-second cache, database-backed). Step-up required for sensitive mutations.

---

## 2. Database Schemas

### 2.1 `users` table

```
apps/api/src/database/schema/user.ts
```

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | internal ID |
| `guuid` | uuid | public-facing ID sent to clients |
| `email` | text | nullable; either email or phone required |
| `phone` | text | nullable |
| `name` | text | |
| `emailVerified` | boolean | |
| `phoneVerified` | boolean | |
| `primaryLoginMethod` | enum | `otp` \| `password` \| `google` |
| `permissionsVersion` | integer | incremented on any RBAC change; snapshot cache key |
| `status` | enum | `active` \| `suspended` \| `locked` |
| `isBlocked` | boolean | hard block by admin |
| `blockedReason` | text | |
| `failedLoginAttempts` | integer | |
| `accountLockedUntil` | timestamp | temporary lockout |
| `mfaEnabled` | boolean | |
| `passwordChangedAt` | timestamp | |
| `lastLoginAt` | timestamp | |
| `imageAttachmentFk` | uuid | FK to attachments |
| `deletedAt` | timestamp | soft delete |

Constraint: `CHECK (email IS NOT NULL OR phone IS NOT NULL)`  
Indexes: `email`, `phone`, `iamUserId`, `status`

---

### 2.2 `devices` table

```
apps/api/src/database/schema/device.ts
```

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `userFk` | uuid | FK → users (cascade delete) |
| `publicKey` | text | Ed25519 public key (full PEM/base64) |
| `publicKeyHash` | text | SHA256 of public key; lookup index |
| `platform` | enum | `ios` \| `android` \| `web` |
| `model` | text | device model string |
| `osVersion` | text | |
| `appVersion` | text | |
| `attestationVerified` | boolean | server-side attestation result |
| `isTrusted` | boolean | manually trusted by admin |
| `isBlocked` | boolean | hard block |
| `label` | text | human name ("Saran's iPhone") |
| `firstSeenAt` | timestamp | |
| `lastSeenAt` | timestamp | |
| `lastIp` | text | |
| `pushToken` | text | FCM/APNs token |
| `lastSyncAt` | timestamp | |
| `blockedAt` | timestamp | |

Unique index: `(userFk, publicKeyHash)` — one device record per user/key pair.

---

### 2.3 `device_sessions` table

```
apps/api/src/database/schema/device-session.ts
```

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | sent as `device_session_guuid` to clients |
| `userFk` | uuid | FK → users |
| `deviceFk` | uuid | FK → devices |
| `expiresAt` | timestamp | session expiry |
| `lastUsedAt` | timestamp | updated on each refresh |
| `lastStepUpAt` | timestamp | when step-up last completed |
| `lastStepUpMethod` | enum | `otp` \| `password` \| `biometric` |
| `stepUpLockedUntil` | timestamp | durable rate-limit lockout |
| `revokedAt` | timestamp | non-null = revoked |
| `revokedReason` | text | |
| `currentJti` | text | active JWT's JTI (for blacklisting) |
| `currentJtiExp` | timestamp | used during cleanup |
| `ipAtCreation` | text | |
| `geoAtCreation` | text | |
| `deviceName` | text | |
| `os` | text | |
| `browser` | text | |
| `appVersion` | text | |
| `platform` | text | |
| `lastAppVersion` | text | |
| `pushToken` | text | |

Indexes: `userFk`, `deviceFk`, `expiresAt`

---

### 2.4 `refresh_tokens` table

```
apps/api/src/database/schema/refresh-token.ts
```

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK (append-only) | never reused |
| `deviceSessionFk` | uuid | FK → device_sessions |
| `tokenHash` | text unique | SHA256 of raw token |
| `parentId` | uuid self-ref | forms rotation chain |
| `issuedAt` | timestamp | |
| `expiresAt` | timestamp | |
| `usedAt` | timestamp | non-null = already rotated; second use = reuse attack |
| `revokedAt` | timestamp | |
| `revokedReason` | text | |
| `familyId` | uuid | groups all tokens in a rotation chain |

Indexes: `tokenHash` (unique), `deviceSessionFk`, `expiresAt`, `parentId`, `tokenHash+revokedAt`, `deviceSessionFk+revokedAt`, `familyId`

---

### 2.5 `sessions` table (BetterAuth)

```
apps/api/src/database/schema/session.ts
```

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | BetterAuth-generated ID |
| `token` | text unique | session token in cookie |
| `expiresAt` | timestamp | |
| `ipAddress` | text | |
| `userAgent` | text | |
| `userId` | text | FK → users (cascade delete) |
| `createdAt` / `updatedAt` | timestamp | |

> Property names must stay camelCase — BetterAuth owns this schema.

---

### 2.6 `web_session_step_ups` table

```
apps/api/src/database/schema/web-session-step-up.ts
```

| Column | Type | Notes |
|---|---|---|
| `sessionId` | text PK | BetterAuth session ID |
| `userFk` | uuid | FK → users (cascade delete) |
| `lastStepUpAt` | timestamp | when step-up completed |
| `lastStepUpMethod` | enum | `otp_sms` \| `totp` \| `password_reentry` |
| `stepUpLockedUntil` | timestamp | durable rate-limit lockout |

Index: `userFk`

---

## 3. Auth Constants

```
apps/api/src/auth/services/auth-constants.service.ts
```

All timing values come from environment variables with these defaults:

| Constant | Default | Description |
|---|---|---|
| `OTP_TTL_SECONDS` | 300 (5 min) | OTP valid window |
| `OTP_RESEND_COOLDOWN_SECONDS` | 60 | Minimum gap between resends |
| `OTP_MAX_ATTEMPTS` | 5 | Attempts before OTP is consumed |
| `DEVICE_CHALLENGE_TTL_SECONDS` | 300 | Challenge for device signature |
| `SESSION_CACHE_TTL_SECONDS` | 30 | Redis cache for session lookups |
| `REFRESH_TOKEN_TTL_SECONDS` | 2592000 (30 days) | Refresh token expiry |
| `ACCESS_TOKEN_TTL_SECONDS` | 900 (15 min) | JWT access token expiry |
| `SNAPSHOT_CACHE_TTL_SECONDS` | 604800 (7 days) | Permission snapshot Redis TTL |
| `STEP_UP_VALIDITY_SECONDS` | 300 (5 min) | Step-up valid window after completion |
| `STEP_UP_RATE_WINDOW_SECONDS` | 300 | Step-up attempt rate window |
| `STEP_UP_MAX_ATTEMPTS` | 5 | Step-up attempts before lockout |
| `MAX_PASSWORD_LENGTH` | 1024 | Bcrypt/Argon2 bomb guard |

---

## 4. Mobile Auth — OTP Login/Signup Flow

### 4.1 Endpoints

```
POST /auth/mobile/login
POST /auth/mobile/signup
```

Both follow a **two-stage protocol**:

- **Stage 1** (no `otpCode`): request an OTP → server sends SMS, returns `otp_request_id`
- **Stage 2** (with `otpCode` + `device`): verify OTP → server issues tokens

### 4.2 Stage 1 — OTP Request

**Login controller** → `AuthLoginService.loginStageOne()`  
**Signup controller** → `AuthSignupService.signupStageOne()`

Both delegate to the shared `OtpRequestService.requestOtp()`:

```
OtpRequestService.requestOtp(phone, purpose, ip)
  ├─ RateLimitService.checkIpLimit()          (5/min per IP)
  ├─ RateLimitService.checkPhoneOtpLimit()    (5/5min per phone)
  ├─ OtpRequestRepository.insertOtpRequest()  (writes to DB)
  ├─ OtpService.sendOtp()
  │    ├─ [production] Msg91Service.sendOtp() (SMS API)
  │    └─ [dev] Redis.set("dev_otp:{phone}", code)
  └─ returns { otp_request_id, phone_masked, expires_in_seconds, resend_available_in_seconds }
```

**Resend flow**: client sends `resend_of: <previous_otp_request_id>`. The service checks the cooldown (60s default) before issuing a new OTP.

### 4.3 Stage 2 — OTP Verification & Token Issuance

**Login flow** (`AuthLoginService.loginStageTwo()` with `otpCode`):

```
1. RateLimitService.checkIpLimit()
2. OtpService.verifyOtp(phone, code, otp_request_id)
   ├─ OtpRequestRepository.findActiveRequest()       (checks expiry, attempts)
   ├─ timingSafeEqual(storedCode, submittedCode)
   └─ OtpRequestRepository.markConsumed()
3. UserRepository.findByPhone()                      (must exist for login)
4. MobileAuthValidator.assertUserActive()            (status check)
5. DeviceService.upsertDevice(userId, deviceInfo)
6. AuthSessionRepository.createSession()             (new device_session row)
7. RefreshTokenService.issueRefreshToken(session)
   └─ crypto.randomBytes(48) → SHA256 hash → DB insert
8. CryptoService.signJwt(payload)                   (15-min access token)
9. AuditService.log(LOGIN_SUCCESS)
10. return { access_token, refresh_token, user, account_id, account_role, device_guuid, is_trusted }
```

**Signup flow** (`AuthSignupService.signupStageTwo()`) differs at step 3+:

```
3. UserRepository.findByPhone() → if exists → throw USER_ALREADY_EXISTS
4. [new user] db.transaction():
   ├─ insertUser()
   ├─ persist DPDP consent (policy_version, timestamp)
   └─ incrementPermissionsVersion()
5. DeviceService.upsertDevice(newUser.id, deviceInfo)
6–10. same as login
   Note: new users have NO account yet — account + subscription are created
         only when the user creates their FIRST store (see §4.5)
```

### 4.4 Login/Signup DTOs

**LoginDto** (`apps/api/src/auth/mobile/dto/login.dto.ts`):

```ts
{
  method: 'otp',
  phone: string,            // 8-20 chars
  otpCode?: string,         // 6 digits, stage 2 only
  otp_request_id?: uuid,    // stage 2 only
  device?: {
    publicKey: string,      // Ed25519 public key
    platform: 'ios' | 'android',
    model?: string,
    osVersion?: string,
    appVersion?: string,
    attestation?: string,
  }
}
```

Validation rule: `otpCode` requires `device` + `otp_request_id` (Zod superRefine).

**SignupDto** adds:
```ts
{
  name?: string,            // 1-120 chars
  consent?: {               // required in stage 2
    dpdp_acknowledged: true,
    policy_version: string,
    name: string,
    email?: string,
    marketing_consent?: boolean,
  }
}
```

> **DPDP re-consent on policy_version bump (F2):** When the backend's current `policy_version` is higher than what was stored at signup, the login response must include `consent_required: true` along with the new `policy_version`. The mobile client must show the updated policy and call a `/auth/mobile/consent` endpoint before the access token is accepted. The in-force consent row is keyed by `(userId, policy_version)` — multiple versions are kept for audit. The `MobileJwtGuard` checks `users.consentPolicyVersion >= current_policy_version` and returns `403 CONSENT_REQUIRED` if the user has not re-consented.

**LoginResponseDto**:
```ts
{
  access_token: string,
  refresh_token: string,
  user: { id: string, permissions_version: number },
  account_id: string | null,     // null until user creates their first store
  account_role: string | null,   // null until user creates their first store
  is_new_user: boolean,
  device_guuid: string,
  device_session_guuid: string,
  is_trusted: boolean,
}
```

> **Why nullable?** A brand-new user who just completed signup has no account yet. The account (and its subscription) is created atomically when the user creates their first store — not at signup time. Clients must handle `account_id: null` by routing the user to the store creation flow.

### 4.5 User State Between Signup and First Store

After a successful signup (stage 2 complete), a new user has:
- A valid `users` row (phoneVerified=true, status=active)
- A device session + access/refresh token pair
- **No** `accounts` row
- **No** `account_subscription` row
- **No** store membership

The user can only call:
- `POST /stores` — to create their first store (which atomically creates the account + subscription)
- Auth endpoints (refresh, logout, sessions)

All other store-scoped endpoints will return `403 STORE_ACCESS_DENIED` via `StoreGuard` because there are no store memberships to match. The mobile client must detect `account_id: null` in the login response and redirect to the onboarding flow before attempting any store operation.

**OtpChallengeResponseDto** (stage 1):
```ts
{
  otp_sent: true,
  expires_in: number,
  otp_request_id?: string,
}
```

---

## 5. Mobile Auth — Token Refresh Flow

### 5.1 Endpoint

```
POST /auth/mobile/refresh
```

Public endpoint (no JWT required). Protected by replay-protection and device challenge.

### 5.2 Request DTO

```ts
{
  refreshToken: string,
  challengeId?: string,         // required if device has a public key
  deviceSignature?: string,     // Ed25519 sig of challenge (hex or base64url)
  idempotencyKey: string,       // 60-second dedup window
  snapshotVersion?: number,     // client's current snapshot version
}
```

### 5.3 Idempotency Layer

```
RefreshIdempotencyService
  ├─ Redis GET "refresh_idem:{idempotencyKey}"
  │    ├─ HIT (status=done) → return cached response immediately
  │    ├─ HIT (status=pending) → wait (poll for up to 3s)
  │    └─ MISS → claim key (SET NX, 60s TTL, status=pending) → proceed
  └─ after rotation: SET key → {status:done, response}, 60s TTL
```

This prevents duplicate refreshes from concurrent requests (e.g., multiple tabs).

### 5.4 Full Refresh Flow

```
RefreshTokenService.rotate(dto)
  │
  ├─ 1. RefreshTokenRepository.findByHash(SHA256(token))
  │      joins device_session + user
  │
  ├─ 2. Precondition checks:
  │      ├─ token expired?          → REFRESH_TOKEN_EXPIRED
  │      ├─ token already used?     → reuse attack detected
  │      │    └─ revokeFamily(familyId) → REFRESH_TOKEN_REUSE
  │      ├─ token revoked?          → REFRESH_TOKEN_REVOKED
  │      ├─ session revoked?        → SESSION_REVOKED
  │      ├─ session expired?        → SESSION_EXPIRED
  │      ├─ user deleted?           → USER_NOT_FOUND
  │      └─ user not active?        → USER_SUSPENDED / USER_LOCKED
  │
  ├─ 3. Device signature check (if device has public key):
  │      ├─ DeviceChallengeService.consumeChallenge(challengeId)
  │      │    └─ Redis DEL "device_challenge:{id}" (single-use)
  │      └─ CryptoService.verifyDeviceSignature(publicKey, challenge, sig)
  │
  ├─ 4. Atomic rotation in DB transaction:
  │      ├─ markTokenUsed(old token)
  │      ├─ insert new refresh token (parentId = old.id, same familyId)
  │      └─ update session.lastUsedAt
  │
  ├─ 5. Blacklist old JWT:
  │      └─ BlacklistCacheService.addToBlacklist(oldJti, exp)
  │           ├─ Redis SETEX "jti:{jti}", TTL
  │           └─ RevokedTokenRepository.insert(jti, exp)
  │
  ├─ 6. Issue new JWT:
  │      └─ CryptoService.signJwt({ sub, jti, deviceSessionId, accountId, accountRole, ... })
  │
  ├─ 7. Build snapshot response:
  │      └─ SnapshotService.getOrBuild(userId)
  │           (returns null if snapshotVersion matches → no payload transfer)
  │
  └─ 8. return { access_token, refresh_token, snapshot, snapshot_changed, store_access_changed }
```

### 5.5 Refresh Response DTO

```ts
{
  access_token: string,
  refresh_token: string,
  snapshot: PermissionSnapshot | null,   // null when snapshot_changed=false
  snapshot_signature: string,            // Ed25519 sig of canonical JSON
  snapshot_changed: boolean,
  store_access_changed: boolean,
}
```

---

## 6. Mobile Auth — JWT Guard (Request Authentication)

```
apps/api/src/auth/mobile/guards/mobile-jwt.guard.ts
```

Applied via `@UseGuards(MobileJwtGuard)` on every protected mobile route.

### 6.1 Guard pipeline (in order)

```
1. Extract Bearer token from Authorization header

2. CryptoService.verifyJwt(token)
   ├─ validates signature with current + previous signing key (rotation support)
   ├─ checks exp
   └─ returns payload: { sub, jti, deviceSessionId, iat, exp }

3. JTI blacklist check (in-process LRU cache → Redis → DB)
   ├─ LRU hit (revoked) → UNAUTHORIZED
   ├─ Redis hit (revoked) → UNAUTHORIZED (backfills LRU)
   └─ DB check (fallback) → UNAUTHORIZED (backfills Redis + LRU)

4. Replay protection (ReplayProtectionService)
   ├─ check X-Timestamp header: must be within ±30s of server time
   └─ check X-Nonce header: Redis SETNX "nonce:{deviceId}:{nonce}", 10min TTL
        └─ already seen → REPLAY_DETECTED

5. Session validation (AuthSessionRepository with 30s Redis cache)
   ├─ session not found  → UNAUTHORIZED
   ├─ session revoked    → SESSION_REVOKED
   ├─ session expired    → SESSION_EXPIRED
   ├─ device blocked     → DEVICE_BLOCKED
   └─ user not found     → UNAUTHORIZED

6. User status check
   ├─ user deleted  → USER_NOT_FOUND
   ├─ user blocked  → USER_BLOCKED
   └─ user suspended/locked → USER_SUSPENDED

7. Attach to request: req.user = { userId, deviceSessionId, deviceId, ... }
```

### 6.2 In-process LRU cache

The guard maintains an in-process LRU (max 10,000 entries) for JTI blacklist lookups. This avoids a Redis round-trip on every authenticated request. TTL matches the JWT's remaining lifetime.

### 6.3 Session cache

`AuthSessionRepository` caches session lookups in Redis at `session:{deviceSessionId}` with a 30-second TTL. This is the primary hot path reduction: most requests skip the DB entirely.

On any session state change (revoke, step-up, logout) `SessionCacheInvalidatorService.invalidate(deviceSessionId)` is called to delete the Redis key.

---

## 7. Mobile Auth — Logout & Session Management

### 7.1 Endpoints

```
POST /auth/mobile/logout          — logout current session
POST /auth/mobile/logout/all      — logout all sessions for this user
GET  /auth/mobile/sessions        — list all sessions
DELETE /auth/mobile/sessions/:id  — revoke specific session
```

### 7.2 Logout flow

```
MobileAuthService.logout(userId, deviceSessionId, currentJti)
  ├─ BlacklistCacheService.addToBlacklist(currentJti, exp)
  ├─ AuthSessionRepository.revokeSession(deviceSessionId)
  │    └─ UPDATE device_sessions SET revokedAt=now(), revokedReason='user_logout'
  ├─ SessionCacheInvalidatorService.invalidate(deviceSessionId)
  └─ AuditService.log(LOGOUT)
```

**Logout all** revokes every non-expired session for the user in one query, blacklists each active JTI, and invalidates all cache keys.

### 7.3 Sessions list

```
AuthSessionRepository.listSessions(userId)
  └─ SELECT device_sessions JOIN devices WHERE userFk=userId AND revokedAt IS NULL
       ORDER BY lastUsedAt DESC
```

Response marks `is_current: session.id === currentDeviceSessionId`.

---

## 8. Mobile Auth — Step-Up Authentication

Step-up is required before sensitive operations (viewing sensitive data, transferring store ownership, etc.).

### 8.1 Endpoint

```
POST /auth/mobile/step-up
```

Requires valid JWT (MobileJwtGuard).

### 8.2 Request DTO

```ts
{
  method: 'otp_sms' | 'biometric' | 'totp' | 'password_reentry',
  credential: string,              // OTP code, biometric sig, TOTP code, or password
  otp_request_id?: uuid,           // required for otp_sms
  challenge_id?: uuid,             // required for biometric
  intended_window_seconds?: number // 1-3600, default from STEP_UP_VALIDITY_SECONDS
}
```

### 8.3 Step-up verification flow

```
StepUpService.verify(userId, deviceSessionId, dto)
  │
  ├─ 1. Dual-layer rate limit check:
  │      ├─ Redis: "stepup:attempts:{deviceSessionId}" count < MAX_ATTEMPTS
  │      └─ DB: stepUpLockedUntil > now() → STEP_UP_LOCKED
  │
  ├─ 2. Method-specific verification:
  │      ├─ otp_sms:
  │      │    ├─ OtpRequestRepository.findActiveRequest(otp_request_id)
  │      │    └─ OtpService.verifyOtp(phone, credential, request)
  │      ├─ biometric:
  │      │    ├─ DeviceChallengeService.consumeChallenge(challenge_id)
  │      │    └─ CryptoService.verifyDeviceSignature(publicKey, challenge, credential)
  │      ├─ totp:
  │      │    └─ TotpService.verify(userSecret, credential)
  │      └─ password_reentry:
  │           └─ PasswordService.verify(stored_hash, credential)
  │
  ├─ 3. On failure:
  │      ├─ Redis INCR "stepup:attempts:{deviceSessionId}" with RATE_WINDOW TTL
  │      └─ if count >= MAX_ATTEMPTS:
  │           └─ AuthSessionRepository.setStepUpLockedUntil(sessionId, now+window)
  │
  ├─ 4. On success:
  │      ├─ Redis DEL "stepup:attempts:{deviceSessionId}"
  │      ├─ AuthSessionRepository.updateStepUp(sessionId, method, now)
  │      └─ SessionCacheInvalidatorService.invalidate(sessionId)
  │
  └─ return { ok: true, method, completed_at, valid_until }
```

### 8.4 Step-up validity check (in guards)

Other guards check step-up freshness:

```ts
const stepUpAge = Date.now() - session.lastStepUpAt
if (stepUpAge > STEP_UP_VALIDITY_SECONDS * 1000) {
  throw new StepUpRequiredException()
}
```

### 8.5 Step-up + Razorpay checkout race (F3)

Subscription checkout requires step-up before the Razorpay order is created (`STEP_UP_VALIDITY_SECONDS = 300`). However, a user may complete step-up, land on the Razorpay payment page, and then the 5-minute window expires before the Razorpay webhook fires.

**Resolution:** The Razorpay webhook is the authoritative backstop. It activates the subscription regardless of whether the original step-up session is still valid:

```
User completes step-up (t=0)
   → StepUpGuard passes → Razorpay order created
User spends >5min on Razorpay page (t=0..360s)
   → step-up session expires at t=300
User pays (t=360)
   → Razorpay fires webhook to /payments/webhook
   → SubscriptionService.activateFromWebhook(orderId)
       ├─ NO step-up check — webhook is server-to-server
       └─ subscription activated regardless of client session state
```

The step-up guard only protects the *order creation* call, not the webhook. Do not require step-up on the webhook endpoint.

---

## 9. Snapshot System

The snapshot is an offline-capable, cryptographically signed representation of a user's permissions, store access, subscription, and RBAC rules. It is embedded in the refresh response and cached on-device.

### 9.1 What a snapshot contains

```ts
PermissionSnapshot {
  userId: string,
  permissionsVersion: number,
  generatedAt: ISO string,
  stores: StoreSnapshot[],        // one per store the user has access to
  globalPermissions: string[],    // super-admin or cross-store perms
}

StoreSnapshot {
  storeId: string,
  storeGuuid: string,
  storeName: string,
  roles: RoleSnapshot[],
  permissions: {
    crud: CrudPermission[],       // entity → { create, read, update, delete }
    special: SpecialPermission[], // named capabilities
  },
  offlineConstraints: OfflineConstraint[],
  location: LocationSnapshot,
}
```

> **Subscription is NOT in the snapshot.** Subscription data (plan, status, features, `access_valid_until`) has its own version counter (`subscription_version`) and is delivered via a separate channel: the `X-Subscription-Version` header emitted by `SubscriptionStatusGuard` (see §9.4). Mixing subscription state into the permission snapshot would mean every plan change triggers a permission snapshot rebuild — wrong coupling. Keep them on separate tracks.

```ts
```

### 9.2 Snapshot build flow

```
SnapshotService.getOrBuild(userId)
  │
  ├─ 1. Redis GET "snapshot:{userId}"
  │      └─ HIT and version matches → return cached (skip build)
  │
  ├─ 2. SnapshotRepository.getUserBaseData(userId)
  │      └─ SELECT user + permissionsVersion
  │
  ├─ 3. SnapshotRepository.getUserStoreAccess(userId)
  │      └─ SELECT store_members JOIN stores (active only)
  │
  ├─ 4. For each store (batched, not N+1):
  │      ├─ SnapshotRepository.getRoleAssignments(userId, storeId)
  │      ├─ SnapshotRepository.getCrudPermissions(roleIds)
  │      ├─ SnapshotRepository.getSpecialPermissions(roleIds)
  │      ├─ SnapshotRepository.getOfflineConstraints(storeId)
  │      └─ SnapshotRepository.getPlanFeatures(planId)  ← 5-min cache
  │
  ├─ 5. Build canonical JSON (sorted keys, deterministic)
  │
  ├─ 6. CryptoService.signSnapshot(canonicalJson)
  │      └─ Ed25519 sign with server private key
  │
  ├─ 7. Redis SET "snapshot:{userId}", 7 days TTL
  │
  └─ 8. return { snapshot, signature }
```

### 9.3 Snapshot cache invalidation

Any change to permissions or roles (RBAC) triggers:

```
user.permissionsVersion++
Redis DEL "snapshot:{userId}"
```

The next refresh request will rebuild and deliver the new snapshot.

> **Subscription changes do NOT invalidate the permission snapshot.** A plan upgrade/downgrade bumps `account_subscription.subscription_version`, not `users.permissionsVersion`. Subscription version is propagated independently via `X-Subscription-Version` (see §9.4).

### 9.4 Snapshot refresh interceptor

```
apps/api/src/auth/mobile/interceptors/snapshot-refresh.interceptor.ts
```

Attached globally to all authenticated mobile responses. It is a **no-op on error responses (4xx/5xx)** — it only appends headers and body on successful (2xx) responses.

After a successful handler run, it appends:

- `X-Permissions-Version: {version}` header — sourced from `MobilePrincipal.permissionsVersion`
- If client's `snapshotVersion` header is stale: full permission snapshot in response body extension

> **Single emitter rule for `X-Subscription-Version`**: this header is emitted by `SubscriptionStatusGuard`, not by `SnapshotRefreshInterceptor`. The guard reads `account_subscription.subscription_version` from cache and appends it on every store-scoped request. Keeping the two version signals in separate emitters avoids coupling: a subscription change does not need to touch the permission snapshot pipeline, and vice versa.

This allows background snapshot refresh without a dedicated endpoint.

---

## 10. OTP System

### 10.1 OTP request lifecycle

```
OtpRequestService.requestOtp(phone, purpose, ip, resend_of?)
  │
  ├─ 1. Rate limits:
  │      ├─ RateLimitService.checkIpLimit(): 5 attempts/minute/IP
  │      └─ RateLimitService.checkPhoneOtpLimit(): 5 requests/5min/phone
  │
  ├─ 2. Resend check (if resend_of provided):
  │      ├─ find previous request
  │      └─ check resend cooldown (60s)
  │
  ├─ 3. OtpRequestRepository.insertOtpRequest()
  │      └─ stores: phone, purpose, expiresAt (now + OTP_TTL), maxAttempts
  │
  ├─ 4. OtpService.generateAndSend(phone, purpose)
  │      ├─ generate: crypto.randomInt(100000, 999999).toString()
  │      ├─ [prod] Msg91Service.sendOtp(phone, code)
  │      └─ [dev]  Redis.set("dev_otp:{phone}", code, OTP_TTL)
  │
  └─ 5. return { otp_request_id, phone_masked, expires_in, resend_available_in, max_attempts }
```

### 10.2 OTP verification

```
OtpService.verifyOtp(phone, submittedCode, requestId)
  │
  ├─ 1. OtpRequestRepository.findActiveRequest(requestId)
  │      ├─ check expiresAt > now
  │      ├─ check attempts < maxAttempts
  │      └─ check phone matches
  │
  ├─ 2. [prod] Msg91Service.verifyOtp(phone, submittedCode)
  │    [dev]  Redis.get("dev_otp:{phone}") then timingSafeEqual(stored, submitted)
  │
  ├─ 3. OtpRequestRepository.incrementAttempts(requestId)
  │
  ├─ 4. On success: OtpRequestRepository.markConsumed(requestId)
  │
  └─ 5. return verified: boolean
```

### 10.3 MSG91 integration

```
apps/api/src/auth/core/msg91.service.ts
```

- HTTP POST to MSG91 API with template ID and OTP
- 10-second timeout guard
- Phone number masked in logs (`+91****1234`)
- Error surfaced as `OTP_SEND_FAILED` (not exposed to client)

---

## 11. Device Management

### 11.1 Device upsert flow

```
DeviceService.upsertDevice(userId, deviceInfo)
  │
  ├─ Compute publicKeyHash = SHA256(publicKey)
  ├─ DeviceRepository.findByUserAndKeyHash(userId, publicKeyHash)
  │    ├─ FOUND → update lastSeenAt, appVersion, osVersion, model, lastIp
  │    └─ NOT FOUND → insert new device row
  │
  └─ return device
```

### 11.2 Device challenge (for refresh token binding)

```
DeviceChallengeService.issueChallenge(deviceId)
  └─ generate UUID challenge
     Redis SETEX "device_challenge:{challengeId}", 300s
     return challengeId

DeviceChallengeService.consumeChallenge(challengeId)
  └─ Redis DEL "device_challenge:{challengeId}"
       └─ missing → CHALLENGE_NOT_FOUND (single-use enforcement)
```

### 11.3 Device signature verification

The device proves possession of its private key by signing the challenge with Ed25519:

```
CryptoService.verifyDeviceSignature(publicKey, challenge, signature)
  └─ ed25519.verify(signature, Buffer.from(challenge), publicKey)
       └─ failure → DEVICE_SIGNATURE_INVALID
```

---

## 12. Security Layers

### 12.1 Rate limiting

```
apps/api/src/auth/core/rate-limit.service.ts
```

| Scope | Limit | Window | Storage |
|---|---|---|---|
| IP (login) | 5 attempts | 1 minute | DB |
| Account (login failures) | 10 failures | 1 hour | DB |
| Email | 5 attempts | 5 minutes | DB |
| Phone OTP | 5 requests | 5 minutes | DB |
| Step-up | 5 attempts | configurable window | Redis + DB |

All limits query `login_attempts` table via `RateLimitRepository`. On exceed → HTTP 429.

### 12.2 Token blacklist

```
apps/api/src/auth/mobile/services/blacklist-cache.service.ts
```

Dual-backed: Redis primary, Postgres fallback.

```
addToBlacklist(jti, exp):
  ├─ Redis SETEX "jti:{jti}", (exp - now) seconds
  └─ RevokedTokenRepository.insert(jti, exp) ON CONFLICT DO NOTHING

isBlacklisted(jti):
  ├─ Redis GET "jti:{jti}" → HIT → true
  └─ MISS → DB SELECT → if found → backfill Redis → true
```

### 12.3 Replay protection

```
apps/api/src/auth/mobile/services/replay-protection.service.ts
```

Applied inside `MobileJwtGuard` on every request:

1. **Timestamp drift**: `|request.timestamp - server.now| <= 30 seconds`
2. **Nonce**: `Redis SETNX "nonce:{deviceId}:{nonce}", 10min` — reject if already exists

Headers required: `X-Timestamp` (Unix ms), `X-Nonce` (UUID).

### 12.4 Refresh token rotation & reuse detection

Each refresh token has a `familyId`. When a token is used:
1. Old token is marked `usedAt = now`
2. New token is created with `parentId = old.id`, same `familyId`

If an **already-used** token is presented again, this signals a theft or replay:
```
RefreshTokenService → detects usedAt != null → revokeFamily(familyId)
  └─ UPDATE refresh_tokens SET revokedAt=now WHERE familyId=X
     → entire chain invalidated
```

### 12.5 User revocation cache

```
apps/api/src/auth/services/user-revocation-cache.service.ts
```

5-second TTL Redis cache for "is this user deleted?" check. Called in `MobileJwtGuard` and `WebSessionGuard`.

- Cache miss → DB query → cache result
- On DB failure → deny access (conservative default)
- On user deletion → `invalidate(userId)`

### 12.6 Audit logging

```
apps/api/src/auth/core/audit.service.ts
```

Events logged: `LOGIN_SUCCESS`, `LOGIN_FAILED`, `LOGOUT`, `TOKEN_REFRESH`, `STEP_UP_ATTEMPT`, `STEP_UP_SUCCESS`, `STEP_UP_FAILED`, `SESSION_REVOKED`, `DEVICE_BLOCKED`, `OTP_SENT`, `OTP_VERIFIED`, `SIGNUP`.

Features:
- Immutable writes (INSERT only, no UPDATE/DELETE on audit rows)
- Transaction-aware variant (`logInTransaction`) for atomic operations
- Entity type resolution (looks up store/device/user names for context)
- Dedicated security logger (separate log stream)
- Includes: userId, actorId, entityType, entityId, metadata, ipAddress, userAgent

### 12.7 CSRF protection (web)

```
apps/api/src/auth/web/csrf.middleware.ts
```

Exempt: GET, HEAD, OPTIONS; Bearer token requests.

For cookie-based requests:
1. Check `Origin` header present
2. Validate origin is in allowed origins list (exact match: protocol + host + port)
3. Same-host fallback via `Host` header comparison
4. Reject on mismatch → 403

### 12.8 Throttling decorators

The mobile controller applies `@Throttle` from NestJS throttler:

```
POST /login          — 10 req/min per IP
POST /signup         — 5 req/min per IP
POST /refresh        — 30 req/min per IP
POST /otp-request    — 5 req/min per IP
POST /step-up        — 10 req/min per IP
```

### 12.9 Token cleanup cron

```
apps/api/src/auth/mobile/services/token-cleanup.service.ts
```

Cron: daily at 03:00 UTC

```sql
DELETE FROM revoked_tokens WHERE expiresAt < NOW()
```

---

## 13. Web Auth — BetterAuth Cookie Sessions

### 13.1 Overview

Web dashboard uses [BetterAuth](https://better-auth.com/) — an opinionated session library that handles sign-in/sign-up, session storage, and cookie management.

```
/auth/web/* → BetterAuthHandler (catch-all @All('*'))
               └─ delegates to betterAuth.handler(req, res)
```

### 13.2 Configuration

```
apps/api/src/auth/better-auth/better-auth.config.ts
```

Key settings:
- `secret`: from environment (`BETTER_AUTH_SECRET`)
- `baseURL`: from environment
- `session.cookieCache`: 60-second TTL (reduces DB hits)
- `session.expiresIn`: 7 days
- `session.updateAge`: 1 day (rolling expiry)
- `advanced.cookiePrefix`: `"ba"` 
- SameSite: `"strict"` (CSRF protection)
- Secure: `true` in production
- Phone number plugin: enabled (for OTP-based login)

### 13.3 Super admin assignment

On first user creation, BetterAuth hooks check `SUPER_ADMIN_EMAILS` env var. If the new user's email is in that list, they are automatically assigned the `SUPER_ADMIN` role:

```ts
// better-auth.config.ts — databaseHooks.user.create.after
if (superAdminEmails.includes(user.email)) {
  await db.insert(userRoles).values({ userId, roleId: SUPER_ADMIN_ROLE_ID })
  await auditService.log(SUPER_ADMIN_ASSIGNED, { userId })
}
```

### 13.4 WebSessionGuard

```
apps/api/src/auth/web/web-session.guard.ts
```

Applied to all web API routes.

```
1. Extract session via betterAuth.api.getSession(req)
   └─ validates cookie + 60s session cache

2. UserRevocationCacheService.isDeleted(userId)
   └─ 5s cache; deny on DB failure

3. Check user.status === 'active'
   ├─ suspended → USER_SUSPENDED
   └─ locked    → USER_LOCKED

4. Attach session to request: req.session = { userId, sessionId, ... }
```

Bearer token bypass: if `Authorization: Bearer` header present, guard passes through (allows API key access alongside cookie sessions).

---

## 14. Web Auth — Step-Up (OTP-SMS)

### 14.1 Endpoint

```
POST /auth/web/step-up
```

Requires active web session (WebSessionGuard).

### 14.2 Request DTO

```ts
{
  method: 'otp_sms',
  credential: string,           // OTP code
  otp_request_id: uuid,
}
```

### 14.3 Web step-up flow

```
WebStepUpController.verify(session, dto)
  │
  ├─ 1. Load step-up record (WebSessionStepUpRepository.findBySessionId)
  │
  ├─ 2. Rate limit check:
  │      ├─ Redis: "web_stepup:{sessionId}" count
  │      └─ DB: stepUpLockedUntil > now() → 429
  │
  ├─ 3. OTP verification (same as mobile: OtpService.verifyOtp)
  │
  ├─ 4. On failure:
  │      ├─ Redis INCR "web_stepup:{sessionId}"
  │      └─ if >= MAX_ATTEMPTS:
  │           └─ WebSessionStepUpRepository.setLockedUntil(sessionId, now+window)
  │
  ├─ 5. On success:
  │      ├─ WebSessionStepUpRepository.upsert(sessionId, userId, method, now)
  │      └─ AuditService.log(STEP_UP_SUCCESS)
  │
  └─ return { ok: true, method, completed_at, valid_until }
```

### 14.4 Step-up validation in other routes

Web routes that require step-up inject the session and check:

```ts
const stepUpAge = Date.now() - session.stepUp?.lastStepUpAt
if (!session.stepUp || stepUpAge > STEP_UP_VALIDITY_SECONDS * 1000) {
  throw new StepUpRequiredException()
}
```

---

## 15. Core Services

### 15.1 CryptoService

```
apps/api/src/auth/core/crypto.service.ts
```

| Method | Description |
|---|---|
| `signJwt(payload)` | Signs JWT with RS256/EdDSA; includes `jti` (UUID), `iat`, `exp` |
| `verifyJwt(token)` | Verifies with current key; falls back to previous key (rotation) |
| `signSnapshot(json)` | Ed25519 sign of canonical JSON snapshot |
| `verifySnapshot(json, sig)` | Verify snapshot on mobile client (or server re-check) |
| `verifyDeviceSignature(pubKey, challenge, sig)` | Ed25519 verify for device binding |
| `hashToken(token)` | SHA256(token) → hex; used for refresh token storage |
| `canonicalJson(obj)` | Deterministic JSON (sorted keys, no spaces) |

Key rotation: signing keys are stored in `signing_keys` table with `isCurrent` flag. `verifyJwt` tries current key, falls back to previous key to allow zero-downtime key rotation.

### 15.2 PasswordService

```
apps/api/src/auth/core/password.service.ts
```

- Algorithm: **Argon2id** (`argon2` npm package)
- Memory: 64 KB
- Time cost: 3 iterations
- Parallelism: 4 threads
- `hash(password)` → Argon2 hash string
- `verify(hash, password)` → boolean
- `needsRehash(hash)` → true if params outdated (triggers transparent rehash on login)

Max password length: 1024 chars (guards against bcrypt/argon2 DoS via huge inputs).

### 15.3 RateLimitService

```
apps/api/src/auth/core/rate-limit.service.ts
```

All limits query `login_attempts` table:

```ts
checkIpLimit(ip):
  count = SELECT COUNT(*) FROM login_attempts 
          WHERE ip=ip AND createdAt > now()-1min
  if count >= 5 → throw RateLimitExceededException

checkAccountLimit(userId):
  count = SELECT COUNT(*) FROM login_attempts
          WHERE userId=userId AND success=false AND createdAt > now()-1hr
  if count >= 10 → throw AccountLockedTemporarilyException

checkEmailLimit(email):
  count = SELECT COUNT(*) FROM login_attempts
          WHERE email=email AND createdAt > now()-5min
  if count >= 5 → throw RateLimitExceededException

checkPhoneOtpLimit(phone):
  count = SELECT COUNT(*) FROM login_attempts
          WHERE phone=phone AND purpose='otp' AND createdAt > now()-5min
  if count >= 5 → throw RateLimitExceededException
```

### 15.4 AuditService

```
apps/api/src/auth/core/audit.service.ts
```

```ts
log(event, context): Promise<void>
logInTransaction(event, context, tx): void  // uses transaction client
```

Writes to `audit_logs` table (append-only). Includes entity resolution (fetches human-readable names for storeId, deviceId, etc.).

---

## 16. Module Wiring

### 16.1 AuthCoreModule

```
apps/api/src/auth/core/auth-core.module.ts
```

Provides and exports:
- `AuditService`
- `CryptoService`
- `Msg91Service`
- `PasswordService`
- `RateLimitRepository`
- `RateLimitService`

### 16.2 MobileAuthModule

```
apps/api/src/auth/mobile/mobile-auth.module.ts
```

Imports: `AuthCoreModule`, `DatabaseModule`, `RedisModule`, `ConfigModule`

Provides:
- `MobileAuthController`
- `AuthLoginService`, `AuthSignupService`, `AuthLogoutService`
- `OtpService`, `OtpRequestService`
- `DeviceService`, `DeviceChallengeService`
- `RefreshTokenService`, `RefreshIdempotencyService`
- `SnapshotService`
- `StepUpService`
- `BlacklistCacheService`, `ReplayProtectionService`
- `TokenCleanupService`
- `SessionCacheInvalidatorService`
- All mobile repositories
- `MobileJwtGuard`
- `SnapshotRefreshInterceptor` (global)

Exports: `MobileJwtGuard`, `SnapshotService`, `OtpService`, `OtpRequestRepository`, `SessionCacheInvalidatorService`

### 16.3 BetterAuthModule

```
apps/api/src/auth/better-auth/better-auth.module.ts
```

Provides: `BetterAuth` instance (factory), `BetterAuthHandler`

Exports: `BetterAuth`

### 16.4 WebAuthModule

```
apps/api/src/auth/web/web-auth.module.ts
```

Imports: `BetterAuthModule`, `MobileAuthModule` (for `OtpService`)

Provides:
- `WebSessionGuard`
- `WebStepUpController` (registered before BetterAuthHandler — order matters)
- `WebSessionStepUpRepository`
- `WebUserRepository`

Exports: `WebSessionGuard`

CSRF middleware applied via `configure(consumer)` to all `/auth/web` routes.

---

## 17. Error Reference

| Code | HTTP | Description |
|---|---|---|
| `REFRESH_TOKEN_EXPIRED` | 401 | Refresh token past `expiresAt` |
| `REFRESH_TOKEN_REVOKED` | 401 | Token explicitly revoked |
| `REFRESH_TOKEN_REUSE` | 401 | Token already rotated; family revoked |
| `SESSION_REVOKED` | 401 | Device session was revoked |
| `SESSION_EXPIRED` | 401 | Device session past `expiresAt` |
| `USER_NOT_FOUND` | 401 | User deleted (soft) |
| `USER_BLOCKED` | 403 | User hard-blocked by admin |
| `USER_SUSPENDED` | 403 | Account suspended |
| `USER_LOCKED` | 403 | Temporary account lockout |
| `DEVICE_BLOCKED` | 403 | Device hard-blocked |
| `DEVICE_SIGNATURE_INVALID` | 401 | Ed25519 sig mismatch |
| `CHALLENGE_NOT_FOUND` | 401 | Challenge expired or already used |
| `OTP_INVALID` | 422 | Wrong OTP code |
| `OTP_EXPIRED` | 422 | OTP request past TTL |
| `OTP_MAX_ATTEMPTS` | 422 | Too many wrong attempts |
| `OTP_ALREADY_CONSUMED` | 422 | OTP already used |
| `OTP_SEND_FAILED` | 500 | MSG91 delivery failure |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many attempts (IP/phone/email) |
| `STEP_UP_REQUIRED` | 403 | Sensitive action needs step-up |
| `STEP_UP_LOCKED` | 429 | Too many failed step-up attempts |
| `REPLAY_DETECTED` | 401 | Nonce already used |
| `APP_VERSION_DEPRECATED` | 426 | App version below minimum |
| `USER_ALREADY_EXISTS` | 409 | Signup with existing phone |

---

## Appendix: Key Redis Key Patterns

| Key | TTL | Description |
|---|---|---|
| `session:{deviceSessionId}` | 30s | Session cache |
| `snapshot:{userId}` | 7 days | Permission snapshot |
| `jti:{jti}` | token remaining TTL | JWT blacklist |
| `nonce:{deviceId}:{nonce}` | 10 min | Replay protection |
| `device_challenge:{challengeId}` | 5 min | Single-use device challenge |
| `dev_otp:{phone}` | 5 min | Dev-mode OTP |
| `otp_rate:{ip}` | 1 min | OTP rate limit (IP) |
| `otp_rate:{phone}` | 5 min | OTP rate limit (phone) |
| `stepup:attempts:{deviceSessionId}` | configurable | Step-up attempt counter |
| `web_stepup:{sessionId}` | configurable | Web step-up attempt counter |
| `refresh_idem:{idempotencyKey}` | 60s | Refresh idempotency |
| `user_deleted:{userId}` | 5s | User revocation cache |
| `plan_features:{planId}` | 5 min | Plan features cache (snapshot build) |

---

## 18. Improvements Adopted from Ayphen 3.0

This section documents gaps identified by comparing our auth system with the Ayphen 3.0 Java/Spring Boot implementation, and what needs to be added or enforced in our codebase.

---

### 18.1 Typed `MobilePrincipal` — replacing untyped `req.user`

**Problem:** `MobileJwtGuard` currently attaches a plain object to `req.user` by spreading JWT payload fields. Controllers access fields like `req.user?.['deviceSessionId']` with no compile-time guarantee those fields exist.

**Solution:** Introduce a typed `MobilePrincipal` interface and enforce it everywhere.

```typescript
// apps/api/src/auth/mobile/types/mobile-principal.ts

export interface MobilePrincipal {
  userId: string;           // internal UUID (users.id)
  userGuuid: string;        // public-facing UUID sent to clients
  deviceSessionId: string;  // active device_session.id
  deviceId: string;         // device.id
  devicePlatform: string;   // 'ios' | 'android'
  permissionsVersion: number; // snapshot cache-busting version
  stepUpAt?: Date;          // when step-up last completed (if ever)
  stepUpMethod?: string;    // 'otp' | 'biometric' | 'totp'
}
```

**Guard change** (`mobile-jwt.guard.ts`):

```typescript
// After all validations pass, build the principal explicitly:
const principal: MobilePrincipal = {
  userId: session.userFk,
  userGuuid: user.guuid,
  deviceSessionId: session.id,
  deviceId: session.deviceFk,
  devicePlatform: session.platform,
  permissionsVersion: user.permissionsVersion,
  stepUpAt: session.lastStepUpAt ?? undefined,
  stepUpMethod: session.lastStepUpMethod ?? undefined,
};
request.user = principal;
```

**NestJS request type augmentation** (`apps/api/src/types/express.d.ts`):

```typescript
import { MobilePrincipal } from '@/auth/mobile/types/mobile-principal';

declare global {
  namespace Express {
    interface Request {
      user?: MobilePrincipal;
    }
  }
}
```

**Impact:** All controllers get full IntelliSense and compile-time safety. No more `as any` or optional chaining into unknown objects.

**Mirrored from:** `UserPrincipal.java` in Ayphen 3.0, which carries `id`, `guuid`, `name`, `username`, `iamUserId`, `passwordHash`, `isVerified` and is the single typed identity object attached to Spring's `SecurityContextHolder`.

---

### 18.2 `RequestContextService` — AsyncLocalStorage (equivalent of `UserContextHolder`)

**Problem:** `userId` and `deviceSessionId` are passed as explicit parameters through every service method:

```
guard → controller → service → repository  (4 hops)
```

This is verbose, requires signature changes on every new auth field, and risks forgetting to pass them.

**Solution:** Use Node.js `AsyncLocalStorage` — the correct TypeScript equivalent of Java's `ThreadLocal`. It stores a value scoped to the current async call chain and is automatically cleared when the chain ends (no memory leak risk unlike a global map).

```typescript
// apps/api/src/auth/core/request-context.service.ts

import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { MobilePrincipal } from '@/auth/mobile/types/mobile-principal';

@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<MobilePrincipal>();

  run<T>(principal: MobilePrincipal, fn: () => T): T {
    return this.storage.run(principal, fn);
  }

  get(): MobilePrincipal | undefined {
    return this.storage.getStore();
  }

  getOrThrow(): MobilePrincipal {
    const ctx = this.storage.getStore();
    if (!ctx) throw new Error('No request context — called outside of a request scope');
    return ctx;
  }
}
```

**Guard change** — wrap the handler call:

```typescript
// mobile-jwt.guard.ts — canActivate()
return this.requestContext.run(principal, () => next.handle());
// AsyncLocalStorage scopes to this async chain; no explicit clear() needed
```

**Usage in any service** (no parameter threading needed):

```typescript
@Injectable()
export class SomeService {
  constructor(private readonly ctx: RequestContextService) {}

  doSomething() {
    const { userId, deviceSessionId } = this.ctx.getOrThrow();
    // use them directly
  }
}
```

**Mirrored from:** `UserContextHolder.java` in Ayphen 3.0:

```java
UserContextHolder.setCurrentUser(principal);   // set in filter
// ... any service calls getCurrentUser() ...
UserContextHolder.clear();                      // cleared in finally block
```

The `AsyncLocalStorage` version is strictly safer — there is no `clear()` to forget because the storage is garbage-collected with the async chain.

---

### 18.3 Token Type Enforcement in `MobileJwtGuard`

**Problem:** `CryptoService.verifyJwt()` validates the signature and expiry but does NOT check the `type` claim. A refresh token (which is also a valid HMAC-signed JWT) can be used as a Bearer access token.

**Attack vector:** An attacker who intercepts or guesses a refresh token (e.g., from a leaked HTTP-only cookie) can put it in the `Authorization: Bearer` header and authenticate API requests — even though the token was never meant for that purpose.

**Solution:** Add a `type` claim to every JWT at issue time, and enforce it in the guard.

**Signing change** (`crypto.service.ts`):

```typescript
// In signJwt() — always embed type
const payload = {
  sub: userId,
  jti: crypto.randomUUID(),
  type: 'access',          // ← add this
  deviceSessionId,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
};
```

**Guard change** (`mobile-jwt.guard.ts`):

```typescript
const payload = await this.cryptoService.verifyJwt(token);

// Enforce token type — refuse refresh tokens used as access tokens
if (payload['type'] !== 'access') {
  throw new UnauthorizedException('INVALID_TOKEN_TYPE');
}
```

**Refresh token** gets `type: 'refresh'` at issue time in `RefreshTokenService`. The refresh endpoint must also check `type === 'refresh'` before rotating, to prevent an access token being submitted to the refresh endpoint.

**Mirrored from:** `JwtTokenProvider.isAccessToken()` in Ayphen 3.0:

```java
public boolean isAccessToken(String token) {
    return "access".equals(getClaim(token, "type"));
}
// JwtAuthenticationFilter rejects tokens where isAccessToken() returns false
```

---

### 18.4 `accountLockedUntil` Enforcement on OTP Failures

**Problem:** The `users` table has `failedLoginAttempts` (integer) and `accountLockedUntil` (timestamp) columns, but `MobileAuthService.login()` does not write to them when OTP verification fails. Rate limiting is handled by `RateLimitService` (per-IP, per-phone) but there is no user-account-level temporary lockout tied to those columns.

**Solution:** After every failed OTP verification during login stage 2, increment `failedLoginAttempts` and conditionally set `accountLockedUntil`.

**Service change** (`mobile-auth.service.ts`):

```typescript
// Constants (in AuthConstantsService)
MAX_FAILED_LOGIN_ATTEMPTS = 5          // env: MAX_FAILED_LOGIN_ATTEMPTS
ACCOUNT_LOCKOUT_DURATION_MINUTES = 30  // env: ACCOUNT_LOCKOUT_DURATION_MINUTES

// In login() stage 2, after OTP verification fails:
async handleFailedOtp(userId: string): Promise<void> {
  const user = await this.usersRepository.findById(userId);
  const attempts = (user.failedLoginAttempts ?? 0) + 1;

  const update: Partial<User> = { failedLoginAttempts: attempts };

  if (attempts >= this.constants.MAX_FAILED_LOGIN_ATTEMPTS) {
    update.accountLockedUntil = new Date(
      Date.now() + this.constants.ACCOUNT_LOCKOUT_DURATION_MINUTES * 60_000
    );
    update.status = 'locked';
    await this.auditService.log('ACCOUNT_LOCKED', { userId, attempts });
  }

  await this.usersRepository.update(userId, update);
}

// In login() stage 2, after OTP verification succeeds:
async handleSuccessfulLogin(userId: string): Promise<void> {
  await this.usersRepository.update(userId, {
    failedLoginAttempts: 0,
    accountLockedUntil: null,
    status: 'active',        // unlock if previously locked
    lastLoginAt: new Date(),
  });
}
```

**Guard enforcement** (`mobile-jwt.guard.ts` — already partially present, confirm complete):

```typescript
// In session/user validation step:
if (user.accountLockedUntil && user.accountLockedUntil > new Date()) {
  throw new ForbiddenException('USER_LOCKED');
}
// status === 'locked' check already exists — this adds the timestamp-based unlock
```

**Mirrored from:** Ayphen 3.0 `AuthServiceImpl` which calls `failedLoginAttempts++` and computes `accountLockedUntil` on every failed password check, and clears them on successful login.

---

### 18.5 Email Verification for Web Registration

**Problem:** Web users who register via BetterAuth with email+password are not required to verify their email before logging in. The `emailVerified` column exists in the `users` table but is not enforced by `WebSessionGuard`.

**Solution:** Add email verification enforcement on the web track.

**Flow:**

```
POST /auth/web/sign-up   (BetterAuth handles this)
  └─ BetterAuth databaseHooks.user.create.after:
       ├─ generate token: crypto.randomBytes(32).toString('hex')
       ├─ store EmailVerificationToken { token, userId, expiresAt: now+24hr, used: false }
       ├─ emailQueue.add('verification', { userId, token, email })   ← async
       └─ user.emailVerified = false (already default)

GET /auth/web/verify-email?token=xxx   (new endpoint)
  ├─ find token in email_verification_tokens
  ├─ check expiresAt > now AND used = false
  ├─ set user.emailVerified = true
  ├─ mark token used
  └─ return 200

POST /auth/web/resend-verification   (new endpoint, requires session)
  ├─ check rate limit: 3 resends per hour per userId
  ├─ generate new token (invalidate old)
  ├─ emailQueue.add('verification', { ... })
  └─ return 200
```

**WebSessionGuard enforcement:**

```typescript
// After session validation:
if (!user.emailVerified) {
  throw new ForbiddenException('EMAIL_NOT_VERIFIED');
}
```

**New DB table** `email_verification_tokens`:

```typescript
// apps/api/src/database/schema/email-verification-token.ts
{
  id: uuid PK,
  userFk: uuid FK → users,
  token: text unique,
  expiresAt: timestamp,
  usedAt: timestamp nullable,
  createdAt: timestamp,
}
```

**Mirrored from:** Ayphen 3.0's `AuthServiceImpl.register()` which generates a verification token, stores it, and emails a link. `UserPrincipal.isEnabled()` returns `user.isVerified` — Spring Security blocks login until verified.

---

### 18.6 Forgot Password / Reset Password (Web Track)

**Problem:** Web users have no self-service password reset flow. If a user forgets their password, there is no recovery path.

**Solution:** Implement the full forgot/reset flow for the web track.

**Endpoints:**

```
POST /auth/web/forgot-password    (public)
POST /auth/web/reset-password     (public)
```

**Forgot password flow:**

```
POST /auth/web/forgot-password
Body: { email: string }

WebAuthService.forgotPassword(email)
  ├─ ALWAYS return 200 (never reveal whether email exists)  ← anti-enumeration
  ├─ UsersRepository.findByEmail(email)
  │    └─ NOT FOUND → return silently (do not throw)
  ├─ generate token: crypto.randomBytes(32).toString('hex')
  ├─ PasswordResetToken { token, userId, expiresAt: now+1hr, usedAt: null }
  │    → upsert (replace existing unused token for same user)
  ├─ emailQueue.add('password-reset', { email, token })   ← async, non-blocking
  └─ return { message: 'If this email is registered, a reset link has been sent.' }
```

**Reset password flow:**

```
POST /auth/web/reset-password
Body: { token: string, newPassword: string }   // newPassword min 8, max 1024 chars

WebAuthService.resetPassword(token, newPassword)
  ├─ PasswordResetTokenRepository.findByToken(token)
  │    └─ NOT FOUND → throw BadRequestException('INVALID_RESET_TOKEN')
  ├─ check token.expiresAt > now
  │    └─ expired → throw BadRequestException('RESET_TOKEN_EXPIRED')
  ├─ check token.usedAt == null
  │    └─ already used → throw BadRequestException('RESET_TOKEN_ALREADY_USED')
  ├─ PasswordService.hash(newPassword)            ← Argon2id
  ├─ db.transaction():
  │    ├─ users.update({ passwordHash, passwordChangedAt: now, status: 'active',
  │    │                  failedLoginAttempts: 0, accountLockedUntil: null })
  │    ├─ passwordResetTokens.update({ usedAt: now })
  │    └─ [BetterAuth] revoke ALL sessions for this user
  │         └─ betterAuth.api.revokeUserSessions({ userId })
  ├─ UserRevocationCacheService.invalidate(userId)    ← bust 5s cache
  ├─ AuditService.log('PASSWORD_RESET', { userId, ip })
  └─ return 200
```

**New DB table** `password_reset_tokens`:

```typescript
// apps/api/src/database/schema/password-reset-token.ts
{
  id: uuid PK,
  userFk: uuid FK → users (cascade delete),
  token: text unique,
  expiresAt: timestamp,
  usedAt: timestamp nullable,
  createdAt: timestamp,
}
Index: token (unique), userFk
```

**Critical:** Password reset MUST revoke all active sessions (mirrors Ayphen 3.0's `refreshTokenRepository.revokeAllByUserId(userId)`). Without this, an attacker who had a stolen session remains authenticated after the victim resets their password.

**Mirrored from:** Ayphen 3.0's `AuthServiceImpl.forgotPassword()` and `resetPassword()` with the exact same silent-failure, single-use token, and full session revocation pattern.

---

### 18.7 Refresh Token in HTTP-Only Scoped Cookie (Web Track)

**Problem:** For web clients, if we ever issue JWT refresh tokens directly (outside BetterAuth's cookie mechanism), they must not be in the response body where JavaScript can read them.

**Solution:** Any web-track token endpoint must follow this pattern:

```typescript
// In controller (web track only):
response.cookie('refreshToken', rawRefreshToken, {
  httpOnly: true,                          // not readable by JS
  sameSite: 'lax',                         // sent on top-level navigation
  secure: process.env.NODE_ENV === 'production',
  path: '/auth/web/refresh',              // scoped — only sent to refresh endpoint
  maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
});

// Return access token in body only:
return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS };
```

**On logout** — server clears the cookie:

```typescript
response.cookie('refreshToken', '', {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/auth/web/refresh',
  maxAge: 0,   // ← immediate expiry
});
```

**Key decisions from Ayphen 3.0:**
- `SameSite=Lax` (not `Strict`) — allows the cookie to be sent when users click a link from an email or external page
- `path` scoped to the refresh endpoint only — the refresh token cookie is NOT sent on every API request, only to `/auth/web/refresh`
- Server-side `Max-Age=0` on logout — does not rely on client-side cookie deletion

**Mirrored from:** Ayphen 3.0's `AuthController.login()` and `logout()` cookie management with `ResponseCookie.from(...).httpOnly(true).sameSite("Lax").path("/api/v1/auth/refresh")`.

---

### 18.8 Password Reset Invalidates All Sessions

**Problem:** When a web user resets their password, their existing BetterAuth sessions remain active. An attacker who had a stolen session (e.g., from a XSS cookie leak or network interception) continues to have access even after the victim resets their password.

**Solution:** On every successful password reset, revoke all sessions for the user across both tracks.

**In `WebAuthService.resetPassword()`** (inside the DB transaction):

```typescript
// Revoke all BetterAuth (web) sessions:
await betterAuth.api.revokeUserSessions({ userId });

// Revoke all mobile device_sessions:
await authSessionRepository.revokeAllUserSessions(userId, 'password_reset');
// → UPDATE device_sessions SET revokedAt=now(), revokedReason='password_reset'
//   WHERE userFk=userId AND revokedAt IS NULL

// Blacklist all active JTIs from mobile sessions:
const activeSessions = await authSessionRepository.getActiveSessionsWithJti(userId);
for (const session of activeSessions) {
  if (session.currentJti) {
    await blacklistCacheService.addToBlacklist(session.currentJti, session.currentJtiExp);
  }
}

// Bust session caches:
await sessionCacheInvalidatorService.invalidateAllForUser(userId);

// Bust user revocation cache:
await userRevocationCacheService.invalidate(userId);
```

**Mirrored from:** Ayphen 3.0's `AuthServiceImpl.resetPassword()`:
```java
refreshTokenRepository.revokeAllByUserId(userId);
// Every refresh token for this user is marked isRevoked=true in one query
```

---

### 18.9 `phoneVerified` Flag Set on OTP Login

**Problem:** The `users.phoneVerified` column exists but there is no clear enforcement that it is set to `true` when a user successfully completes OTP login stage 2. If it is not set, the `MobileAuthValidator` or guard cannot use it as a verified-contact gate.

**Solution:** In `MobileAuthService.login()` stage 2, after successful OTP verification, ensure:

```typescript
// If user.phoneVerified is false (edge case: user created via another path):
if (!user.phoneVerified) {
  await usersRepository.update(user.id, { phoneVerified: true });
}
```

**Guard enforcement** — add to `MobileJwtGuard` user status checks:

```typescript
if (!user.phoneVerified) {
  throw new ForbiddenException('PHONE_NOT_VERIFIED');
}
```

This closes the gap identified from Ayphen 3.0's `UserPrincipal.isEnabled()` which returns `user.isVerified` — making verification a hard gate at the auth layer, not buried in business logic.

---

### 18.10 Transparent Password Rehash on Login

**Problem:** `PasswordService.needsRehash(hash)` exists (returns `true` if the stored hash was created with outdated Argon2 parameters) but it is not confirmed to be called during login. If parameters are upgraded (e.g., memory cost increased from 64KB to 128KB), existing users' hashes are never updated until explicitly changed.

**Solution:** Call `needsRehash()` on every successful password-based login and transparently update:

```typescript
// In any password-based login flow (web password login, step-up password_reentry):
const isValid = await passwordService.verify(user.passwordHash, submittedPassword);
if (!isValid) throw new UnauthorizedException('INVALID_CREDENTIALS');

// Transparent rehash:
if (passwordService.needsRehash(user.passwordHash)) {
  const newHash = await passwordService.hash(submittedPassword);
  await usersRepository.update(user.id, { passwordHash: newHash });
  // No response change — user doesn't notice
}
```

This is a one-line migration path: upgrade params in `PasswordService`, and all users are transparently rehashed on their next login.

**Mirrored from:** Ayphen 3.0 pattern where `PasswordEncoder.upgradeEncoding(hash)` is checked after every successful verify.

---

### 18.11 Structured Error Code Naming Convention

**Problem:** Our current error codes are unstructured strings (`REFRESH_TOKEN_EXPIRED`, `USER_NOT_FOUND`, `DEVICE_BLOCKED`). Mobile clients must string-match error codes. Support teams have no numeric lookup system. Adding new codes has no convention to follow.

**Solution:** Adopt Ayphen 3.0's `Domain_C_NNN` / `Domain_M_NNN` naming convention going forward. Existing codes are NOT renamed (breaking change for mobile clients) — new codes follow the new pattern.

**Convention:**

```
{DOMAIN}_{C|M}_{NNN}
  DOMAIN = 3-letter domain prefix
  C = code (machine-readable, sent to client)
  M = message (human-readable, for logging/admin)
  NNN = zero-padded sequential number
```

**Domain prefixes:**

| Prefix | Domain |
|---|---|
| `USR` | User |
| `AUTH` | Authentication |
| `TOK` | Token |
| `SES` | Session |
| `DEV` | Device |
| `OTP` | OTP |
| `SUP` | Step-up |
| `SNAP` | Snapshot |
| `RATE` | Rate limiting |
| `PERM` | Permissions |
| `GEN` | Generic/cross-cutting |

**Example mapping** (new codes only — do not rename existing):

```typescript
// apps/api/src/constant/errorcode/auth-error-codes.ts

export const AuthErrorCodes = {
  // Token
  TOK_C_001: 'TOK_C_001',  // Invalid token type (access token used as refresh, or vice versa)
  TOK_C_002: 'TOK_C_002',  // Token signature invalid

  // User (new additions)
  USR_C_001: 'USR_C_001',  // Email not verified
  USR_C_002: 'USR_C_002',  // Phone not verified
  USR_C_003: 'USR_C_003',  // Account temporarily locked (accountLockedUntil)

  // Password reset
  AUTH_C_001: 'AUTH_C_001', // Invalid reset token
  AUTH_C_002: 'AUTH_C_002', // Reset token expired
  AUTH_C_003: 'AUTH_C_003', // Reset token already used

  // Email verification
  AUTH_C_004: 'AUTH_C_004', // Invalid verification token
  AUTH_C_005: 'AUTH_C_005', // Verification token expired
} as const;
```

**Mirrored from:** Ayphen 3.0's `ErrorCodeConstants.java` (1105 lines) with `USR_C_001`/`USR_M_001` pairs for every domain.

---

### 18.12 `StoreGuard` — Uniform Tenant/Store Isolation ⚠️ P0 — NOT YET BUILT

> **Priority: P0 — build before any store-scoped endpoint ships.** Without this guard, any authenticated user who knows a `storeId` UUID can call that store's API regardless of membership. This is a complete tenant isolation failure — user from store A can read and write store B's data.

**Problem:** Store membership checks (`is this user a member of storeId?`) are done inside individual service methods — not at a single enforced entry point. If a developer forgets to add the check in a new endpoint, a user from store A can access store B's data.

**Solution:** Create a `StoreGuard` that runs after `MobileJwtGuard` / `WebSessionGuard` on all store-scoped endpoints:

```typescript
// apps/api/src/auth/guards/store.guard.ts

@Injectable()
export class StoreGuard implements CanActivate {
  constructor(
    private readonly redis: RedisService,
    private readonly db: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.userId ?? request.session?.userId;

    // Extract storeId from route params, query, or body (in that priority order)
    const storeId =
      request.params.storeId ??
      request.query.storeId ??
      request.body?.storeId;

    if (!storeId) return true; // Non-store-scoped endpoint — pass through

    // Check Redis cache first
    const cacheKey = `store_access:${userId}:${storeId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached !== null) {
      if (cached === '0') throw new ForbiddenException('STORE_ACCESS_DENIED');
      return true;
    }

    // DB check
    const isMember = await this.db
      .select()
      .from(storeMembers)
      .where(
        and(
          eq(storeMembers.userId, userId),
          eq(storeMembers.storeId, storeId),
          isNull(storeMembers.deletedAt),
        ),
      )
      .limit(1);

    const hasAccess = isMember.length > 0;

    // Cache result for 30s
    await this.redis.setex(cacheKey, 30, hasAccess ? '1' : '0');

    if (!hasAccess) throw new ForbiddenException('STORE_ACCESS_DENIED');
    return true;
  }
}
```

**Usage** — applied at controller level on all store-scoped controllers:

```typescript
@Controller('stores/:storeId')
@UseGuards(MobileJwtGuard, StoreGuard)  // StoreGuard runs after JWT is validated
export class StoreController { ... }
```

**Cache invalidation** — when a user is removed from a store:

```typescript
await redis.del(`store_access:${userId}:${storeId}`);
```

**Mirrored from:** Ayphen 3.0's `PrincipalManager.checkPermission()` which validates `tenantId` against the user's company membership before ANY permission check, as a first gate.

---

### 18.13 Activity Log Prefix/Suffix Template System

**Problem:** Our `AuditService` logs raw structured JSON events (`{ event: 'LOGIN_SUCCESS', userId, metadata: {...} }`). The audit log UI must interpret raw JSON to display human-readable messages. Adding new event types requires frontend changes to render them.

**Solution:** Add `prefix` and `suffix` text templates to audit log entries, so the UI can render human-readable sentences without knowing the event schema.

**Schema addition** to `audit_logs` table:

```typescript
// New columns on audit_logs:
{
  prefix: text,     // e.g. "User", "Device", "Session"
  suffix: text,     // e.g. "logged in from Chennai", "was blocked by admin"
  activityType: enum,  // AUTH_LOGIN | AUTH_LOGOUT | AUTH_PASSWORD_RESET |
                       // AUTH_STEP_UP | SESSION_REVOKED | DEVICE_BLOCKED |
                       // SIGNUP | OTP_SENT | OTP_VERIFIED | PERMISSION_CHANGED
}
```

**UI rendering:** `"{prefix} {entityName} {suffix}"` → `"User Saran logged in from Chennai"`

**`AuditService` change** — add template fields to every log call:

```typescript
// audit.service.ts — log() signature extension
interface AuditLogEntry {
  event: string;
  userId: string;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  prefix: string;    // ← new
  suffix: string;    // ← new
  activityType: ActivityType;  // ← new enum
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

// Example calls:
await auditService.log({
  event: 'AUTH_LOGIN',
  activityType: ActivityType.AUTH_LOGIN,
  prefix: 'User',
  suffix: `logged in from ${geo ?? ip}`,
  userId,
  ipAddress: ip,
});

await auditService.log({
  event: 'DEVICE_BLOCKED',
  activityType: ActivityType.DEVICE_BLOCKED,
  prefix: 'Device',
  suffix: `was blocked by admin`,
  userId,
  entityType: 'device',
  entityId: deviceId,
  actorId: adminUserId,
});
```

**Queryable by:** `userId`, `storeId`/`companyId`, `activityType`, `entityType+entityId`, date range.

**Mirrored from:** Ayphen 3.0's `ActivityLog` entity with `ActivityLogPrefix` and `ActivityLogSuffix` lookup tables and comment threading support.

---

### 18.14 `isVerified` / Account Status — Complete Guard Enforcement Checklist

Ayphen 3.0's `UserPrincipal.isEnabled()` is called by Spring Security automatically on every auth attempt, making verification a hard gate at the framework level. We need to ensure equivalent coverage at every entry point.

**Current state audit:**

| Check | `MobileJwtGuard` | `WebSessionGuard` | Login stage 2 | Notes |
|---|---|---|---|---|
| `status === 'active'` | ✅ | ✅ | ✅ | |
| `isBlocked === true` | ✅ | ✅ | — | Hard block |
| `accountLockedUntil > now` | ⚠️ partial | ❌ missing | ❌ missing | Add per §18.4 |
| `emailVerified === true` | ❌ missing | ❌ missing | n/a | Add per §18.5 |
| `phoneVerified === true` | ❌ missing | n/a | ⚠️ set but not checked | Add per §18.9 |
| `deletedAt IS NOT NULL` | ✅ (via UserRevocationCache) | ✅ | — | |

**`MobileJwtGuard` — complete user status block** (after session loads user):

```typescript
// Ordered checks — most critical first:
if (user.deletedAt) throw new UnauthorizedException('USER_NOT_FOUND');
if (user.isBlocked) throw new ForbiddenException('USER_BLOCKED');
if (user.status === 'suspended') throw new ForbiddenException('USER_SUSPENDED');
if (user.status === 'locked') throw new ForbiddenException('USER_LOCKED');
if (user.accountLockedUntil && user.accountLockedUntil > new Date()) {
  throw new ForbiddenException('USER_LOCKED');  // timestamp-based temporary lock
}
if (!user.phoneVerified) throw new ForbiddenException('PHONE_NOT_VERIFIED');
// emailVerified not checked on mobile track (phone is the verified contact)
```

**`WebSessionGuard` — complete user status block:**

```typescript
if (user.isBlocked) throw new ForbiddenException('USER_BLOCKED');
if (user.status !== 'active') throw new ForbiddenException('USER_SUSPENDED');
if (user.accountLockedUntil && user.accountLockedUntil > new Date()) {
  throw new ForbiddenException('USER_LOCKED');
}
if (!user.emailVerified) throw new ForbiddenException('EMAIL_NOT_VERIFIED');
```

---

### 18.15 Async Email Queue for Web Auth Emails

**Problem:** When implementing email verification (§18.5) and password reset (§18.6), email sending must never block the HTTP response. A slow SMTP server or transient failure must not result in a 500 or timeout for the user.

**Solution:** Use a Bull queue for all auth email sends. This also provides automatic retry on failure and survives process restarts.

```typescript
// apps/api/src/auth/email/email.queue.ts

@Injectable()
export class AuthEmailProducer {
  constructor(
    @InjectQueue('auth-email') private readonly queue: Queue,
  ) {}

  async sendVerificationEmail(userId: string, email: string, token: string) {
    await this.queue.add('verification', { userId, email, token }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }

  async sendPasswordResetEmail(userId: string, email: string, token: string) {
    await this.queue.add('password-reset', { userId, email, token }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }
}

// apps/api/src/auth/email/email.processor.ts

@Processor('auth-email')
export class AuthEmailProcessor {
  constructor(private readonly mailerService: MailerService) {}

  @Process('verification')
  async handleVerification(job: Job<{ userId, email, token }>) {
    const link = `${process.env.WEB_APP_URL}/auth/verify-email?token=${job.data.token}`;
    await this.mailerService.sendMail({
      to: job.data.email,
      subject: 'Verify your email — Ayphen',
      html: `<p>Click <a href="${link}">here</a> to verify your email. Link expires in 24 hours.</p>`,
    });
  }

  @Process('password-reset')
  async handlePasswordReset(job: Job<{ userId, email, token }>) {
    const link = `${process.env.WEB_APP_URL}/auth/reset-password?token=${job.data.token}`;
    await this.mailerService.sendMail({
      to: job.data.email,
      subject: 'Reset your password — Ayphen',
      html: `<p>Click <a href="${link}">here</a> to reset your password. Link expires in 1 hour.</p>`,
    });
  }
}
```

**Mirrored from:** Ayphen 3.0's `@Async` annotation on `EmailServiceImpl.sendVerificationEmail()` and `sendPasswordResetEmail()` — both are non-blocking fire-and-forget with Spring's async thread pool.

---

### 18.16 Swagger / OpenAPI — Bearer Security Scheme

**Problem:** Protected mobile endpoints need the JWT bearer token configured in Swagger so developers can test authenticated routes without external tools.

**Solution:** Ensure the OpenAPI config registers the JWT bearer scheme and applies it globally:

```typescript
// apps/api/src/configuration/swagger.config.ts

const config = new DocumentBuilder()
  .setTitle('Ayphen Retail API')
  .setVersion('1.0')
  .addBearerAuth(
    {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',      // ← show "JWT" in Swagger UI lock icon
      name: 'Authorization',
      in: 'header',
    },
    'mobile-jwt',               // ← security scheme name
  )
  .addCookieAuth('ba-session-token', { type: 'apiKey', in: 'cookie' }, 'web-session')
  .build();

// Apply 'mobile-jwt' to all mobile routes via @ApiBearerAuth('mobile-jwt')
// Apply 'web-session' to all web routes via @ApiCookieAuth('web-session')
```

**Controller decorator:**

```typescript
@ApiTags('mobile-auth')
@ApiBearerAuth('mobile-jwt')
@UseGuards(MobileJwtGuard)
@Controller('stores/:storeId')
export class StoreController { ... }
```

**Mirrored from:** Ayphen 3.0's `SwaggerConfig.java` which adds `SecurityScheme.Type.HTTP` with `scheme("bearer").bearerFormat("JWT")` and a global `SecurityRequirement`.

---

### 18.17 Implementation Priority

| Priority | Section | Change | Effort |
|---|---|---|---|
| **P0 — Security fixes** | §18.3 | Token type enforcement in `MobileJwtGuard` | 1 hour |
| **P0 — Security fixes** | §18.4 | `accountLockedUntil` write on OTP failure | 2 hours |
| **P0 — Security fixes** | §18.14 | Complete guard status checklist | 2 hours |
| **P1 — Feature gaps** | §18.5 | Email verification for web registration | 1 day |
| **P1 — Feature gaps** | §18.6 | Forgot/reset password for web track | 1 day |
| **P1 — Feature gaps** | §18.8 | Password reset revokes all sessions | 2 hours |
| **P1 — Feature gaps** | §18.9 | `phoneVerified` set and enforced on login | 1 hour |
| **P2 — Developer UX** | §18.1 | Typed `MobilePrincipal` interface | 3 hours |
| **P2 — Developer UX** | §18.2 | `RequestContextService` (AsyncLocalStorage) | 4 hours |
| **P2 — Developer UX** | §18.7 | Refresh token in HTTP-only cookie (web) | 2 hours |
| **P2 — Developer UX** | §18.16 | Swagger bearer scheme | 1 hour |
| **P3 — Quality** | §18.10 | Transparent password rehash on login | 1 hour |
| **P0 — Security fixes** | §18.12 | `StoreGuard` uniform tenant isolation (UNBUILT) | 4 hours |
| **P3 — Quality** | §18.15 | Async email queue (Bull) | 4 hours |
| **P4 — Future** | §18.11 | Structured error code naming | 1 week |
| **P4 — Future** | §18.13 | Activity log prefix/suffix templates | 3 days |
