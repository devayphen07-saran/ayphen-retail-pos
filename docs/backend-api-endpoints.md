# Ayphen Retail POS — Backend API Reference

Complete reference of **every HTTP endpoint** exposed by the NestJS backend (`apps/backend`), with full detail on functionality, service logic, request payloads, and response shapes.

- **Framework:** NestJS (Express adapter, ESM)
- **Global prefix:** `/api` — applied to every route **except** `GET /health` and `GET /docs*` (Swagger), which are served at the bare path.
- **Auth scheme:** `Authorization: Bearer <access_jwt>` for protected routes.
- **Docs UI:** `GET /docs` (Swagger).

---

## Table of Contents

1. [Global Behaviour](#1-global-behaviour)
2. [Standard Envelopes](#2-standard-envelopes)
3. [Guards & Security Layers](#3-guards--security-layers)
4. [Endpoint Index](#4-endpoint-index)
5. [Auth / Mobile Endpoints](#5-auth--mobile-endpoints) (`/api/auth/mobile/*`)
6. [Store Endpoints](#6-store-endpoints) (`/api/stores`)
7. [Role Endpoints](#7-role-endpoints) (`/api/stores/:storeId/roles/*`)
8. [Invitation Endpoints](#8-invitation-endpoints)
9. [Utility Endpoints](#9-utility-endpoints) (root, health)
10. [Entitlement Limits Reference](#10-entitlement-limits-reference)

---

## 1. Global Behaviour

Configured in `src/bootstrap/apply-global-config.ts` and `src/main.ts`.

| Concern | Behaviour |
|---|---|
| **Global prefix** | `/api` (excludes `GET /health`, `GET /docs`, `GET /docs/*`) |
| **Request timeout** | 30 s hard timeout → `408 Request Timeout` |
| **Body limits** | Governed by `JSON_BODY_LIMIT` env var (JSON + urlencoded) |
| **Trust proxy** | Enabled (1 hop); client IP read from `x-forwarded-for` first entry, else socket address |
| **`x-powered-by`** | Disabled |
| **CORS** | Enabled via `cors.config.ts` |
| **Throttling** | Global rate limiting via `@nestjs/throttler`; `/health` is `@SkipThrottle()`. Exceeding limits → `429` `rate_limit_exceeded` |
| **Pipes (in order)** | `TrimStringPipe` (trims strings, `"   "` → null) → `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`, implicit conversion). Validation failures → `422` `validation_failed` |
| **Filters** | `AllExceptionsFilter` (global) — normalizes all errors into the error envelope |
| **Interceptors** | `RequestContextInterceptor` (AsyncLocalStorage) → `ResponseInterceptor` (wraps success envelope) |
| **Request correlation** | `x-request-id` header echoed into every envelope |

> **Note on DTO validation:** Controllers additionally run **Zod** parsing (`parse(body, Schema)`) inside handlers for the auth/stores request bodies. Zod failures also surface as `422 validation_failed` with field-level `issues`.

---

## 2. Standard Envelopes

### Success (2xx) — `ResponseInterceptor`

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Success",
  "data": { "...": "handler return value, or null" },
  "requestId": "<x-request-id, if sent>",
  "timestamp": "2026-07-01T14:30:45.123Z"
}
```

- `message` is overridable per-handler via `@ResponseMessage('...')`; defaults to `"Success"`.
- `204 No Content` handlers return an empty body (no envelope payload).

### Error (4xx / 5xx) — `AllExceptionsFilter`

```json
{
  "success": false,
  "statusCode": 403,
  "message": "Store not found",
  "data": null,
  "errorCode": "store_not_found",
  "issues": [{ "field": "email", "message": "must be a valid email" }],
  "requestId": "<x-request-id, if sent>",
  "timestamp": "2026-07-01T14:30:45.123Z"
}
```

- `errorCode` — machine-readable, lowercase snake_case. `SCREAMING_SNAKE` thrown messages are auto-converted (`STORE_NOT_FOUND` → message `"Store not found"`, code `store_not_found`).
- `issues` — present only for validation errors (`422`).

| HTTP | errorCode examples | Cause |
|---|---|---|
| 401 | `missing_token`, `invalid_token_type`, `token_revoked`, `session_expired` | Auth failures |
| 403 | `permission_denied`, `store_not_found`, `not_account_owner`, `subscription_inactive` | Authorization |
| 404 | `store_not_accessible`, `not_found` | Missing resource |
| 409 | `duplicate_entry`, `role_already_exists` | Conflict / unique violation |
| 422 | `validation_failed`, `token_expired`, `invalid_credentials` | Input / OTP validation |
| 429 | `rate_limit_exceeded`, `step_up_locked` | Throttling / step-up lockout |
| 500 | `internal_error` | Unhandled |

---

## 3. Guards & Security Layers

Guards run **in the order listed** on each protected route.

| Guard | Applied on | Checks | Attaches |
|---|---|---|---|
| **MobileJwtGuard** | All authenticated routes | Bearer JWT valid & `type=access`; JTI not blacklisted; session exists/not revoked/not expired; replay protection (`x-timestamp`, `x-nonce`); device not blocked; user active, phone verified | `req.user` = `MobilePrincipal` |
| **TenantGuard** | Store-scoped RBAC routes | Resolves store from `@StoreContext(source)`; verifies user can access it (timing-oracle safe: unknown & forbidden both → `404`) | `req.context` = `ResolvedStoreContext` |
| **PermissionsGuard** | RBAC routes | `@RequirePermissions({entity, action})` CRUD gate; H-6 cache-bust; SOC2 audit on denial | `req.context.permissions` |
| **StepUpAuthGuard** | `@StepUpAuth({within})` routes | Recent MFA within window | — |
| **SuperAdminGuard** | `/admin/*` | System-wide `SUPER_ADMIN` role | — |
| StoreGuard / SubscriptionStatusGuard | Legacy store routes | Legacy tenant + subscription-active gate | `req.storeContext` |

### `MobilePrincipal` (attached to `req.user`)

```ts
{
  userId: string; userGuuid: string;
  deviceSessionId: string; deviceId: string; devicePlatform: string;
  permissionsVersion: number; jwtPv: number;   // H-6 cache-bust pair
  stepUpAt?: Date; stepUpMethod?: string;
  currentJti: string; currentJtiExp: Date;     // for logout blacklisting
}
```

### Required headers (protected routes)

| Header | Purpose |
|---|---|
| `Authorization: Bearer <jwt>` | Access token |
| `x-timestamp`, `x-nonce` | Replay protection (JWT guard) |
| `x-request-id` | (optional) request correlation |
| `x-client-mode` | (optional) `offline_replay` rejected on `@OnlineOnly()` routes |

---

## 4. Endpoint Index

| # | Method | Path | Auth | Purpose |
|---|---|---|---|---|
| 1 | POST | `/api/auth/mobile/login/otp` | Public | Request login OTP |
| 2 | POST | `/api/auth/mobile/login/verify` | Public | Verify login OTP → tokens |
| 3 | POST | `/api/auth/mobile/signup/otp` | Public | Request signup OTP |
| 4 | POST | `/api/auth/mobile/signup/verify` | Public | Verify signup OTP → create account |
| 5 | POST | `/api/auth/mobile/refresh` | Public (token in body) | Rotate refresh token |
| 6 | POST | `/api/auth/mobile/logout` | JWT | Logout current session |
| 7 | POST | `/api/auth/mobile/logout/all` | JWT | Logout all sessions |
| 8 | GET | `/api/auth/mobile/sessions` | JWT | List active sessions (paginated) |
| 9 | DELETE | `/api/auth/mobile/sessions/:id` | JWT | Revoke a specific session |
| 10 | POST | `/api/auth/mobile/step-up/challenge` | JWT | Issue device challenge (biometric) |
| 11 | POST | `/api/auth/mobile/step-up/otp` | JWT | Request step-up OTP |
| 12 | POST | `/api/auth/mobile/step-up/verify` | JWT | Verify step-up credential |
| 13 | POST | `/api/stores` | JWT | Create a store |
| 14 | GET | `/api/stores/:storeId/roles` | JWT + RBAC `Role:view` | List roles |
| 15 | POST | `/api/stores/:storeId/roles` | JWT + RBAC `Role:create` | Create custom role |
| 16 | PATCH | `/api/stores/:storeId/roles/:roleId/permissions` | JWT + RBAC `Role:edit` | Replace role permissions |
| 17 | DELETE | `/api/stores/:storeId/roles/:roleId` | JWT + RBAC `Role:delete` | Delete custom role |
| 18 | POST | `/api/stores/:storeId/roles/:roleId/assign` | JWT + RBAC `UserRoleMapping:create` | Assign role to user |
| 19 | DELETE | `/api/stores/:storeId/roles/:roleId/members/:userId` | JWT + RBAC `UserRoleMapping:delete` | Revoke role from user |
| 20 | POST | `/api/stores/:storeId/invitations` | JWT + RBAC `Invitation:create` | Create staff invitation |
| 21 | POST | `/api/invitations/accept` | JWT | Accept an invitation |
| 22 | GET | `/api/` | Public | Hello API |
| 23 | GET | `/health` | Public (no prefix) | Health check |

---

## 5. Auth / Mobile Endpoints

Controller: `MobileAuthController` — base path `auth/mobile`.
Services: `AuthLoginService`, `AuthSignupService`, `AuthLogoutService`, `RefreshTokenService`, `StepUpService`, `DeviceChallengeService`, `OtpRequestService`, `OtpService`.

**Shared `device` object** (used on verify endpoints):

```ts
device: {
  platform:    "ios" | "android",   // required
  app_version: string,              // required
  os_version?: string,
  model?:      string,
  public_key:  string,              // required, Ed25519 public key (min length 1)
  push_token?: string,
  attestation?: string,
}
```

**Phone format:** `PHONE_REGEX = /^\+?[1-9]\d{6,14}$/`.

---

### 1. POST `/api/auth/mobile/login/otp` — Request login OTP

- **Auth:** Public · **Success status:** `200`
- **Service:** `AuthLoginService.loginStageOne(phone, ip, resend_of)` → `OtpRequestService.requestOtp(phone, 'login', ip, resendOf)`

**Request body**
```json
{ "phone": "+919876543210", "resend_of": "uuid (optional)" }
```

**Functionality**
1. Rate-limit checks: per-IP limit + per-phone OTP limit (`RateLimitService`).
2. Acquire Redis lock `otp_lock:{phone}:login` (5s TTL, `SET NX`) — concurrent request → `429`.
3. If `resend_of` set: enforce `OTP_RESEND_COOLDOWN_SECONDS` since prior request.
4. Insert OTP request row (`purpose=login`, `maxAttempts`, `expiresAt = now + OTP_TTL`).
5. Generate 6-digit code → SMS via **Msg91** (prod) or Redis `dev_otp:{phone}` (non-prod).
6. Record rate-limit attempt.

**Response `data`**
```json
{ "otp_sent": true, "otp_request_id": "uuid", "expires_in": 600 }
```

**Errors:** `429 rate_limit_exceeded` (IP/phone limit, concurrent request, resend cooldown).

**Service code — `AuthLoginService.loginStageOne`** (`auth-login.service.ts`)
```ts
/** Stage 1 — request an OTP for login. */
async loginStageOne(phone: string, ip: string, resendOf?: string): Promise<StageOneResult> {
  const result = await this.otpReqService.requestOtp(phone, 'login', ip, resendOf);
  return { otpSent: true, expiresIn: result.expiresIn, otpRequestId: result.otpRequestId };
}
```

**Underlying `OtpRequestService.requestOtp`** (`otp-request.service.ts`) — shared by login/signup/step-up OTP requests:
```ts
async requestOtp(
  phone: string,
  purpose: OtpPurpose,
  ip: string,
  resendOf?: string,
): Promise<OtpRequestResult> {
  await this.rateLimitService.checkIpLimit(ip);
  await this.rateLimitService.checkPhoneOtpLimit(phone);

  const lockKey = `otp_lock:${phone}:${purpose}`;
  const acquired = await this.redis.set(lockKey, '1', 'EX', 5, 'NX');
  if (!acquired)
    throw new AppException(ErrorCodes.RATE_LIMIT_EXCEEDED, 'Request in progress', 429);

  if (resendOf) {
    const prev = await this.otpRepo.findById(resendOf);
    if (prev) {
      const elapsed = (Date.now() - prev.createdAt.getTime()) / 1000;
      if (elapsed < this.constants.OTP_RESEND_COOLDOWN_SECONDS) {
        throw new AppException(
          ErrorCodes.RATE_LIMIT_EXCEEDED,
          'Resend not yet available — please wait before requesting another OTP',
          429,
        );
      }
    }
  }

  const ttl = this.constants.OTP_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000);

  const request = await this.otpRepo.insert({
    phone, purpose, maxAttempts: this.constants.OTP_MAX_ATTEMPTS, expiresAt,
  });

  await this.otpService.generateAndSend(phone, ttl);
  await this.rateLimitService.recordAttempt({ ip, phone, purpose, success: false });

  return {
    otpRequestId: request.id,
    phoneMasked: this.maskPhone(phone),
    expiresIn: ttl,
    resendAvailableIn: this.constants.OTP_RESEND_COOLDOWN_SECONDS,
    maxAttempts: this.constants.OTP_MAX_ATTEMPTS,
  };
}

private maskPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return phone.slice(0, -4).replace(/./g, '*') + phone.slice(-4);
}
```

**OTP generation — `OtpService.generateAndSend`** (`otp.service.ts`)
```ts
async generateAndSend(phone: string, ttlSeconds: number): Promise<string> {
  const code = String(randomInt(100_000, 999_999));
  if (this.config.nodeEnv !== 'production') {
    await this.redis.setex(devOtpKey(phone), ttlSeconds, code);  // dev_otp:{phone}
  } else {
    await this.msg91.sendOtp(phone, code);                       // Msg91 SMS
  }
  return code;
}
```

---

### 2. POST `/api/auth/mobile/login/verify` — Verify login OTP

- **Auth:** Public · **Success status:** `200`
- **Service:** `AuthLoginService.loginStageTwo(phone, otp_code, otp_request_id, device, ip)`

**Request body**
```json
{
  "phone": "+919876543210",
  "otp_code": "123456",
  "otp_request_id": "uuid",
  "device": { "platform": "android", "app_version": "1.0.0", "public_key": "..." }
}
```

**Functionality**
1. IP rate-limit check.
2. Load OTP request by id+phone → missing/stale → `422 token_expired`.
3. Load user by phone → missing → `401 not_found`.
4. Verify OTP (`OtpService.verifyOtp`): consumed/max-attempts → `422 token_invalid`; expired → `422 token_expired`; mismatch → `422 invalid_credentials`. Marks OTP consumed on success.
5. **On failure:** increment `failedLoginAttempts`; lock account if `>= MAX_FAILED_LOGIN_ATTEMPTS`; record rate-limit; re-throw.
6. **On success (single DB transaction):**
   - Reset `failedLoginAttempts=0`, clear lock, `status=active`, set `lastLoginAt`, `phoneVerified=true`.
   - Upsert device (update `lastIp`).
   - Create device session (`expiresAt = now + REFRESH_TOKEN_TTL`, stores app version/platform/push token).
   - Issue refresh token (48-byte random hex, stored hashed with `familyId`).
7. Sign access JWT (`sub`, `deviceSessionId`, `pv`); store `currentJti`/`currentJtiExp` on session.
8. Audit `LOGIN_SUCCESS`.

**Response `data`** (`LoginResponse`)
```json
{
  "access_token": "jwt",
  "refresh_token": "hex",
  "user": { "id": "uuid", "permissions_version": 1 },
  "is_new_user": false,
  "device_guuid": "uuid",
  "device_session_guuid": "uuid",
  "is_trusted": false
}
```

**Errors:** `429 rate_limit_exceeded`, `422 token_expired`, `401 not_found`, `422 token_invalid`, `422 invalid_credentials`.

**Service code — `AuthLoginService.loginStageTwo`** (`auth-login.service.ts`)
```ts
async loginStageTwo(
  phone: string, otpCode: string, otpRequestId: string,
  deviceInfo: DeviceInfo, ip: string,
): Promise<LoginResult> {
  await this.rateLimit.checkIpLimit(ip);

  const otpRequest = await this.otpRepo.findActiveRequest(otpRequestId, phone);
  if (!otpRequest) throw new AppException(ErrorCodes.TOKEN_EXPIRED, 'OTP_EXPIRED', 422);

  const [user] = await this.db.select().from(users).where(eq(users.phone, phone));
  if (!user) throw new AppException(ErrorCodes.NOT_FOUND, 'USER_NOT_FOUND', 401);

  try {
    await this.otpService.verifyOtp(phone, otpCode, otpRequest);
  } catch (err) {
    await this.handleFailedOtp(user.id);
    await this.rateLimit.recordAttempt({ ip, phone, purpose: 'login', success: false });
    throw err;
  }

  // All writes commit together or roll back together — no orphan device/session.
  const { device, session, refreshToken } = await this.uow.execute(async (tx) => {
    await this.handleSuccessfulLogin(user.id, tx);

    const device  = await this.deviceService.upsertDevice(user.id, { ...deviceInfo, lastIp: ip }, tx);
    const session = await this.sessionRepo.create({
      userFk:       user.id,
      deviceFk:     device.id,
      expiresAt:    new Date(Date.now() + this.constants.REFRESH_TOKEN_TTL_SECONDS * 1000),
      ipAtCreation: ip,
      appVersion:   deviceInfo.appVersion,
      platform:     deviceInfo.platform,
      pushToken:    deviceInfo.pushToken,
    }, tx);

    const refreshToken = await this.tokenService.issueRefreshToken(session.id, tx);
    return { device, session, refreshToken };
  });

  const accessToken = await this.crypto.signJwt(user.id, session.id, user.permissionsVersion);

  await this.audit.log({
    event: 'LOGIN_SUCCESS', activityType: 'AUTH_LOGIN',
    prefix: 'User', suffix: `logged in from ${ip}`,
    userId: user.id, ipAddress: ip, metadata: { platform: deviceInfo.platform },
  });
  await this.rateLimit.recordAttempt({ ip, phone, purpose: 'login', success: true });

  return {
    accessToken, refreshToken,
    user: { id: user.guuid, permissionsVersion: user.permissionsVersion },
    isNewUser: false,
    deviceGuuid: device.id, deviceSessionGuuid: session.id,
    isTrusted: device.isTrusted,
  };
}

// Atomic increment; lock account when threshold crossed.
private async handleFailedOtp(userId: string): Promise<void> {
  const [row] = await this.db.update(users)
    .set({ failedLoginAttempts: sql`${users.failedLoginAttempts} + 1` })
    .where(eq(users.id, userId))
    .returning({ attempts: users.failedLoginAttempts });

  const attempts = row?.attempts ?? 0;
  if (attempts >= this.constants.MAX_FAILED_LOGIN_ATTEMPTS) {
    await this.db.update(users).set({
      accountLockedUntil: new Date(Date.now() + this.constants.ACCOUNT_LOCKOUT_DURATION_MINUTES * 60_000),
      status: 'locked',
    }).where(eq(users.id, userId));
  }
}

private async handleSuccessfulLogin(userId: string, tx?: DbExecutor): Promise<void> {
  await (tx ?? this.db).update(users).set({
    failedLoginAttempts: 0, accountLockedUntil: null, status: 'active',
    lastLoginAt: new Date(), phoneVerified: true,
  }).where(eq(users.id, userId));
}
```

**OTP verification — `OtpService.verifyOtp`** (`otp.service.ts`)
```ts
async verifyOtp(phone: string, submitted: string, request: OtpRequest): Promise<void> {
  if (request.consumedAt)                     throw new AppException(ErrorCodes.TOKEN_INVALID, 'OTP_ALREADY_CONSUMED', 422);
  if (request.attempts >= request.maxAttempts) throw new AppException(ErrorCodes.TOKEN_INVALID, 'OTP_MAX_ATTEMPTS', 422);
  if (new Date() > request.expiresAt)          throw new AppException(ErrorCodes.TOKEN_EXPIRED, 'OTP_EXPIRED', 422);

  let valid = false;
  if (this.config.nodeEnv !== 'production') {
    const stored = await this.redis.get(devOtpKey(phone));
    if (stored) {
      const a = Buffer.from(stored.padEnd(6));
      const b = Buffer.from(submitted.padEnd(6));
      valid = a.length === b.length && timingSafeEqual(a, b);   // timing-safe compare
    }
  } else {
    valid = true;  // MSG91 template verification — they hold the OTP server-side
  }

  await this.otpRepo.incrementAttempts(request.id);
  if (!valid) throw new AppException(ErrorCodes.INVALID_CREDENTIALS, 'OTP_INVALID', 422);
  await this.otpRepo.markConsumed(request.id);
}
```

---

### 3. POST `/api/auth/mobile/signup/otp` — Request signup OTP

- **Auth:** Public · **Success status:** `200`
- **Service:** `AuthSignupService.signupStageOne(phone, ip)` → `OtpRequestService.requestOtp(phone, 'signup', ip)`

**Request body**
```json
{ "phone": "+919876543210" }
```

Identical flow to login OTP request but with `purpose=signup` (see `OtpRequestService.requestOtp` above).

**Response `data`**
```json
{ "otp_sent": true, "otp_request_id": "uuid", "expires_in": 600 }
```

**Errors:** `429 rate_limit_exceeded`.

**Service code — `AuthSignupService.signupStageOne`** (`auth-signup.service.ts`)
```ts
/** Stage 1 — request an OTP for signup. */
async signupStageOne(phone: string, ip: string): Promise<StageOneResult> {
  const result = await this.otpReqService.requestOtp(phone, 'signup', ip);
  return { otpSent: true, expiresIn: result.expiresIn, otpRequestId: result.otpRequestId };
}
```

---

### 4. POST `/api/auth/mobile/signup/verify` — Verify signup OTP & create account

- **Auth:** Public · **Success status:** `201`
- **Service:** `AuthSignupService.signupStageTwo(phone, otp_code, otp_request_id, name, device, ip)`

**Request body**
```json
{
  "phone": "+919876543210",
  "otp_code": "123456",
  "otp_request_id": "uuid",
  "name": "Saran",
  "consent_given": true,
  "device": { "platform": "ios", "app_version": "1.0.0", "public_key": "..." }
}
```
- `name`: 1–100 chars. `consent_given`: must be literal `true`.

**Functionality**
1. IP rate-limit check.
2. Check existing user by phone → exists → `409 duplicate_entry`.
3. Load OTP request → missing → `422 token_expired`; verify OTP (same as login).
4. **Single DB transaction:**
   - Insert user (`phoneVerified=true`, `primaryLoginMethod=otp`).
   - **Bootstrap tenant** via `AccountBootstrapService.bootstrap`: creates account ownership, membership, and **trial subscription** (14-day trial).
   - Upsert device; create device session; issue refresh token.
5. Sign access JWT. Audit `SIGNUP`.

**Response `data`** (`LoginResponse`, `is_new_user=true`, `is_trusted=false`)

**Errors:** `429 rate_limit_exceeded`, `409 duplicate_entry`, `422 token_expired`/`token_invalid`/`invalid_credentials`.

**Service code — `AuthSignupService.signupStageTwo`** (`auth-signup.service.ts`)
```ts
async signupStageTwo(
  phone: string, otpCode: string, otpRequestId: string,
  name: string, deviceInfo: DeviceInfo, ip: string,
): Promise<LoginResult> {
  await this.rateLimit.checkIpLimit(ip);

  const existing = await this.db.select({ id: users.id }).from(users).where(eq(users.phone, phone));
  if (existing.length) throw new AppException(ErrorCodes.DUPLICATE_ENTRY, 'USER_ALREADY_EXISTS', 409);

  const otpRequest = await this.otpRepo.findActiveRequest(otpRequestId, phone);
  if (!otpRequest) throw new AppException(ErrorCodes.TOKEN_EXPIRED, 'OTP_EXPIRED', 422);
  try {
    await this.otpService.verifyOtp(phone, otpCode, otpRequest);
  } catch (err) {
    await this.rateLimit.recordAttempt({ ip, phone, purpose: 'signup', success: false });
    throw err;
  }

  // User creation + device + session + refresh token are one atomic unit.
  const { user, device, session, refreshToken } = await this.uow.execute(async (tx) => {
    const [user] = await tx.insert(users).values({
      phone, name, phoneVerified: true, primaryLoginMethod: 'otp',
    }).returning();

    // Provision tenant: account (owned by user) + membership + trialing subscription.
    await this.accountBootstrap.bootstrap(user!.id, tx);

    const device = await this.deviceService.upsertDevice(user!.id, { ...deviceInfo, lastIp: ip }, tx);
    const session = await this.sessionRepo.create({
      userFk: user!.id, deviceFk: device.id,
      expiresAt: new Date(Date.now() + this.constants.REFRESH_TOKEN_TTL_SECONDS * 1000),
      ipAtCreation: ip, appVersion: deviceInfo.appVersion, platform: deviceInfo.platform,
    }, tx);

    const refreshToken = await this.tokenService.issueRefreshToken(session.id, tx);
    return { user: user!, device, session, refreshToken };
  });

  const accessToken = await this.crypto.signJwt(user.id, session.id, user.permissionsVersion);
  await this.audit.log({
    event: 'SIGNUP', activityType: 'AUTH_SIGNUP',
    prefix: 'User', suffix: `signed up with phone`, userId: user.id, ipAddress: ip,
  });

  return {
    accessToken, refreshToken,
    user: { id: user.guuid, permissionsVersion: user.permissionsVersion },
    isNewUser: true,
    deviceGuuid: device.id, deviceSessionGuuid: session.id, isTrusted: false,
  };
}
```

---

### 5. POST `/api/auth/mobile/refresh` — Rotate refresh token

- **Auth:** Public (token supplied in body) · **Success status:** `200`
- **Service:** `RefreshTokenService.rotate({ refreshToken, challengeId, deviceSignature, snapshotVersion })`

**Request body**
```json
{
  "refresh_token": "hex",
  "challenge_id": "uuid (optional)",
  "device_signature": "base64 (optional)",
  "snapshot_version": 3
}
```

**Functionality**
1. **Idempotency:** hash token → return cached `RotateResult` if present (safe retries).
2. Validate token + session + user:
   - Not found → `401 refresh_token_revoked`; already used → **revoke whole family** → `401 refresh_token_reuse`; revoked → `401 refresh_token_revoked`; expired → `401 refresh_token_expired`.
   - Session revoked/expired → `401 session_revoked`/`session_expired`. User deleted → `401 user_not_found`; inactive → `401 user_suspended`.
3. **Device-binding proof (mandatory for untrusted devices):** load the device by `session.deviceFk` → missing → `401 device_not_found`. If the device is **not** `is_trusted`, `challenge_id` + `device_signature` are **required** (omitting either → `401 device_proof_required`); the challenge is consumed (Redis `getdel`) and the Ed25519 signature over `challengeId` is verified → failures → `401 challenge_not_found` / `device_signature_invalid`. Trusted devices may skip the per-refresh signature. *(Note: `is_trusted` currently defaults to `false` and is never set to `true`, so in practice **every** refresh must carry device proof today.)*
4. **Transaction:** mark old token used; insert new token (chained `parentId`/`familyId`, new `expiresAt`); update session `lastUsedAt`.
5. Blacklist old JWT; sign new JWT; update session `currentJti`/`currentJtiExp`; invalidate session cache; cache idempotency result.

**Response `data`** (`RefreshResponse`)
```json
{ "access_token": "jwt", "refresh_token": "hex", "snapshot_version": 1 }
```

**Errors:** `401` — `refresh_token_revoked`, `refresh_token_reuse`, `refresh_token_expired`, `session_revoked`, `session_expired`, `user_not_found`, `user_suspended`, `device_not_found`, `device_proof_required`, `challenge_not_found`, `device_signature_invalid`.

**Service code — `RefreshTokenService.rotate` + `performRotation`** (`refresh-token.service.ts`)
```ts
/** Idempotent entry point — keyed on the incoming refresh token. */
async rotate(dto: RotateInput): Promise<RotateResult> {
  const idemKey = this.crypto.hashToken(dto.refreshToken);

  const cached = await this.idempotency.claim(idemKey);
  if (cached) return this.reviveResult(cached);     // safe retry → identical result

  try {
    const result = await this.performRotation(dto);
    await this.idempotency.complete(idemKey, result);
    return result;
  } catch (err) {
    await this.idempotency.release(idemKey);
    throw err;
  }
}

private async performRotation(dto: RotateInput): Promise<RotateResult> {
  const tokenHash = this.crypto.hashToken(dto.refreshToken);
  const record    = await this.tokenRepo.findByHash(tokenHash);
  if (!record) throw new UnauthorizedException('REFRESH_TOKEN_REVOKED');

  const { session, user } = record;

  // 1. Validate token + session + user
  if (record.usedAt) {                                        // reuse attack
    await this.tokenRepo.revokeFamily(record.familyId, 'reuse_detected');
    throw new UnauthorizedException('REFRESH_TOKEN_REUSE');
  }
  if (record.revokedAt)                    throw new UnauthorizedException('REFRESH_TOKEN_REVOKED');
  if (new Date() > record.expiresAt)       throw new UnauthorizedException('REFRESH_TOKEN_EXPIRED');
  if (session.revokedAt)                   throw new UnauthorizedException('SESSION_REVOKED');
  if (new Date() > session.expiresAt)      throw new UnauthorizedException('SESSION_EXPIRED');
  if (user.deletedAt)                      throw new UnauthorizedException('USER_NOT_FOUND');
  if (user.status !== 'active')            throw new UnauthorizedException('USER_SUSPENDED');

  // 2. Device-binding proof — MANDATORY unless the device is explicitly trusted.
  const [device] = await this.db
    .select({ publicKey: devices.publicKey, isTrusted: devices.isTrusted })
    .from(devices).where(eq(devices.id, session.deviceFk));
  if (!device) throw new UnauthorizedException('DEVICE_NOT_FOUND');

  if (!device.isTrusted) {
    if (!dto.challengeId || !dto.deviceSignature) {
      throw new UnauthorizedException('DEVICE_PROOF_REQUIRED');
    }
    await this.challenge.consumeChallenge(dto.challengeId);
    const ok = await this.crypto.verifyDeviceSignature(device.publicKey, dto.challengeId, dto.deviceSignature);
    if (!ok) throw new UnauthorizedException('DEVICE_SIGNATURE_INVALID');
  }

  // 3. Atomic rotation
  const raw          = randomBytes(48).toString('hex');
  const newTokenHash = this.crypto.hashToken(raw);
  const expiresAt    = new Date(Date.now() + this.constants.REFRESH_TOKEN_TTL_SECONDS * 1000);

  await this.tokenRepo.markUsed(record.id);
  await this.tokenRepo.insert({
    deviceSessionFk: session.id, tokenHash: newTokenHash,
    parentId: record.id, familyId: record.familyId, expiresAt,
  });
  await this.sessionRepo.updateLastUsed(session.id);

  // 4. Blacklist old JWT
  if (session.currentJti && session.currentJtiExp) {
    await this.blacklist.addToBlacklist(session.currentJti, session.currentJtiExp);
  }

  // 5. Issue new JWT
  const accessToken = await this.crypto.signJwt(user.id, session.id, user.permissionsVersion);
  const newJtiExp   = new Date(Date.now() + this.constants.ACCESS_TOKEN_TTL_SECONDS * 1000);
  const parts  = accessToken.split('.');
  const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as { jti: string };

  await this.sessionRepo.updateCurrentJti(session.id, claims.jti, newJtiExp);
  await this.cacheInvalidator.invalidate(session.id);

  return {
    accessToken, refreshToken: raw,
    newJti: claims.jti, newJtiExp,
    userId: user.id, deviceSessionId: session.id,
    snapshotVersion: user.permissionsVersion,
  };
}

/** New refresh tokens (also used on login/signup). */
async issueRefreshToken(deviceSessionFk: string, tx?: DbExecutor): Promise<string> {
  const raw       = randomBytes(48).toString('hex');
  const tokenHash = this.crypto.hashToken(raw);
  const familyId  = randomUUID();
  const expiresAt = new Date(Date.now() + this.constants.REFRESH_TOKEN_TTL_SECONDS * 1000);
  await this.tokenRepo.insert({ deviceSessionFk, tokenHash, familyId, expiresAt }, tx);
  return raw;
}
```

---

### 6. POST `/api/auth/mobile/logout` — Logout current session

- **Auth:** JWT · **Success status:** `204`
- **Service:** `AuthLogoutService.logout(userId, deviceSessionId, currentJti, currentJtiExp)`

**Request body:** none.

**Functionality:** blacklist current JWT (`jti` until `jtiExp`); mark session `revokedAt` (`reason=user_logout`); invalidate session cache; audit `LOGOUT`.

**Response:** `204 No Content`.

**Service code — `AuthLogoutService.logout`** (`auth-logout.service.ts`)
```ts
async logout(userId: string, deviceSessionId: string, currentJti: string, jtiExp: Date): Promise<void> {
  await this.blacklist.addToBlacklist(currentJti, jtiExp);
  await this.sessionRepo.revokeSession(deviceSessionId, 'user_logout');
  await this.cacheInvalidator.invalidate(deviceSessionId);
  await this.audit.log({
    event: 'LOGOUT', activityType: 'AUTH_LOGOUT',
    prefix: 'User', suffix: 'logged out', userId,
  });
}
```

---

### 7. POST `/api/auth/mobile/logout/all` — Logout all sessions

- **Auth:** JWT · **Success status:** `204`
- **Service:** `AuthLogoutService.logoutAll(userId)`

**Functionality:** load all active sessions; blacklist each session's `currentJti`; revoke all (`reason=user_logout_all`); invalidate all session caches; audit `LOGOUT_ALL` with count.

**Response:** `204 No Content`.

**Service code — `AuthLogoutService.logoutAll`** (`auth-logout.service.ts`)
```ts
async logoutAll(userId: string): Promise<void> {
  const sessions = await this.sessionRepo.getActiveSessionsWithJti(userId);
  for (const s of sessions) {
    if (s.currentJti && s.currentJtiExp) {
      await this.blacklist.addToBlacklist(s.currentJti, s.currentJtiExp);
    }
  }
  await this.sessionRepo.revokeAllUserSessions(userId, 'user_logout_all');
  await this.cacheInvalidator.invalidateAllForUser(userId);
  await this.audit.log({
    event: 'LOGOUT_ALL', activityType: 'AUTH_LOGOUT',
    prefix: 'User', suffix: `logged out of all sessions (${sessions.length})`, userId,
  });
}
```

---

### 8. GET `/api/auth/mobile/sessions` — List active sessions

- **Auth:** JWT · **Success status:** `200` · **Interceptor:** `SnapshotRefreshInterceptor`
- **Service:** `AuthLogoutService.listSessions(userId, { limit, cursor })`

**Query params:** `limit` (clamped by `clampLimit`), `cursor` (opaque keyset cursor).

**Functionality:** keyset-paginated list of active sessions (`revokedAt IS NULL`, newest first), joined with device metadata. `is_current` marks the caller's own session (`deviceSessionId`).

**Response `data`** (`PaginatedResponse<SessionResponse>`)
```json
{
  "items": [{
    "id": "uuid",
    "device_name": "iPhone 14",
    "os": "iOS 17",
    "platform": "ios",
    "app_version": "1.0.0",
    "ip_at_creation": "1.2.3.4",
    "last_used_at": "2026-07-01T...",
    "last_step_up_at": null,
    "created_at": "2026-07-01T...",
    "is_current": true
  }],
  "nextCursor": "opaque|null",
  "hasMore": false
}
```

**Service code — `AuthLogoutService.listSessions`** (`auth-logout.service.ts`) — delegates keyset pagination to the repo:
```ts
async listSessions(
  userId: string,
  page: { limit: number; cursor?: string },
): Promise<CursorPage<SessionWithDevice>> {
  return this.sessionRepo.listActiveSessions(userId, page);
}
```
The controller maps the page to `SessionResponse[]` via `SessionMapper.toSessionListResponse(page, deviceSessionId)`, flagging the caller's own session as `is_current`.

---

### 9. DELETE `/api/auth/mobile/sessions/:id` — Revoke a specific session

- **Auth:** JWT · **Success status:** `204`
- **Service:** `AuthLogoutService.revokeSession(sessionId, userId)`
- **Path param:** `id` — UUID (`ParseUUIDPipe`).

**Functionality:** load active session owned by caller → not found / not owned → `404 not_found`. Then **identical machinery to `logout`** so revocation is *immediate*: blacklist the target session's JWT (`currentJti` until `currentJtiExp`), mark `revokedAt` (`reason=user_revoked`), invalidate the session cache, and audit `SESSION_REVOKED`. This closes the window where a revoked (e.g. stolen) device could keep working until the session-cache TTL and access-JWT both lapsed.

**Response:** `204 No Content`. **Errors:** `404 not_found`.

**Service code — `AuthLogoutService.revokeSession`** (`auth-logout.service.ts`)
```ts
async revokeSession(sessionId: string, userId: string): Promise<void> {
  const target = await this.sessionRepo.findActiveByIdForUser(sessionId, userId);
  if (!target) throw new AppException(ErrorCodes.NOT_FOUND, 'Session not found', 404);

  // Same kill-a-session machinery as logout() — blacklist + cache-invalidate make
  // revocation immediate (critical for revoking a compromised device remotely).
  if (target.currentJti && target.currentJtiExp) {
    await this.blacklist.addToBlacklist(target.currentJti, target.currentJtiExp);
  }
  await this.sessionRepo.revokeSession(sessionId, 'user_revoked');
  await this.cacheInvalidator.invalidate(sessionId);
  await this.audit.log({
    event: 'SESSION_REVOKED', activityType: 'AUTH_LOGOUT',
    prefix: 'User', suffix: 'revoked a session', userId,
  });
}
```

---

### 10. POST `/api/auth/mobile/step-up/challenge` — Issue device challenge

- **Auth:** JWT · **Success status:** `200/201`
- **Service:** `DeviceChallengeService.issueChallenge(deviceId)`

**Functionality:** generate random UUID `challengeId`; store in Redis `device_challenge:{id}` = `deviceId` with `DEVICE_CHALLENGE_TTL`. Used for biometric/device-signature step-up.

**Response `data`** (`ChallengeResponse`)
```json
{ "challenge_id": "uuid" }
```

**Service code — `DeviceChallengeService`** (`device-challenge.service.ts`)
```ts
async issueChallenge(deviceId: string): Promise<string> {
  const challengeId = randomUUID();
  await this.redis.setex(challengeKey(challengeId), this.constants.DEVICE_CHALLENGE_TTL_SECONDS, deviceId);
  return challengeId;
}

// One-time consume used by refresh + biometric step-up:
async consumeChallenge(challengeId: string): Promise<string> {
  const deviceId = await this.redis.getdel(challengeKey(challengeId));   // device_challenge:{id}
  if (!deviceId) throw new UnauthorizedException('CHALLENGE_NOT_FOUND');
  return deviceId;
}
```

---

### 11. POST `/api/auth/mobile/step-up/otp` — Request step-up OTP

- **Auth:** JWT · **Success status:** `200`
- **Service:** `AuthLoginService.loginStageOne(phone, ip)` (reused)

**Request body**
```json
{ "phone": "+919876543210" }
```

**Functionality:** issues an OTP (via the login OTP flow) for `otp_sms` step-up. Reuses `AuthLoginService.loginStageOne(phone, ip)` → `OtpRequestService.requestOtp(phone, 'login', ip)` (code shown under endpoint 1).

**Response `data`**
```json
{ "otp_sent": true, "otp_request_id": "uuid", "expires_in": 600 }
```

**Errors:** `429 rate_limit_exceeded`.

---

### 12. POST `/api/auth/mobile/step-up/verify` — Verify step-up credential

- **Auth:** JWT · **Success status:** `200`
- **Service:** `StepUpService.verify(userId, deviceSessionId, dto)`

**Request body**
```json
{
  "method": "otp_sms | biometric | totp | password_reentry",
  "credential": "otp-code-or-signature",
  "otp_request_id": "uuid (required for otp_sms)",
  "challenge_id": "uuid (required for biometric)",
  "intended_window_seconds": 300
}
```
- Zod `superRefine`: `otp_sms` requires `otp_request_id`; `biometric` requires `challenge_id`. `intended_window_seconds`: 1–3600.

**Functionality**
1. Load session → missing → `401 session_revoked`.
2. Load user phone + device public key (never trust caller) → `401 user_not_found` / `device_not_found`.
3. Lockout check: `session.stepUpLockedUntil > now` → `429 step_up_locked`.
4. Verify by method:
   - **`otp_sms`** → verify OTP by `otp_request_id`+phone (same rules as login).
   - **`biometric`** → consume Redis challenge → verify Ed25519 signature over `challengeId`.
   - **`totp` / `password_reentry`** → `422 validation_failed` (unsupported).
5. **On failure:** increment `stepup:attempts:{sessionId}`; at `STEP_UP_MAX_ATTEMPTS` set `stepUpLockedUntil = now + STEP_UP_RATE_WINDOW`; re-throw.
6. **On success:** clear attempt counter; set `lastStepUpAt` + `lastStepUpMethod`; validity = `intended_window_seconds` or `STEP_UP_VALIDITY_SECONDS`; invalidate session cache.

**Response `data`** (`StepUpResponse`)
```json
{
  "ok": true,
  "method": "otp_sms",
  "completed_at": "2026-07-01T...",
  "valid_until": "2026-07-01T..."
}
```

**Errors:** `401 session_revoked`/`user_not_found`/`device_not_found`/`challenge_not_found`/`device_signature_invalid`, `429 step_up_locked`, `422 validation_failed`/`token_expired`/`token_invalid`/`invalid_credentials`.

**Service code — `StepUpService.verify` + `verifyMethod`** (`step-up.service.ts`)
```ts
async verify(userId: string, deviceSessionId: string, dto: StepUpDto): Promise<StepUpResult> {
  const session = await this.sessionRepo.findById(deviceSessionId);
  if (!session) throw new UnauthorizedException('SESSION_REVOKED');

  // Resolve phone + publicKey from DB — never trust caller-supplied values.
  const [[user], [device]] = await Promise.all([
    this.db.select({ phone: users.phone }).from(users).where(eq(users.id, userId)),
    this.db.select({ publicKey: devices.publicKey }).from(devices).where(eq(devices.id, session.deviceFk)),
  ]);
  if (!user?.phone)       throw new UnauthorizedException('USER_NOT_FOUND');
  if (!device?.publicKey) throw new UnauthorizedException('DEVICE_NOT_FOUND');
  const phone = user.phone, publicKey = device.publicKey;

  // 1. Lockout check
  if (session.stepUpLockedUntil && session.stepUpLockedUntil > new Date()) {
    throw new AppException(ErrorCodes.RATE_LIMIT_EXCEEDED, 'STEP_UP_LOCKED', 429);
  }

  const attemptsKey = stepUpKey(deviceSessionId);   // stepup:attempts:{sessionId}
  try {
    await this.verifyMethod(phone, publicKey, dto);
  } catch (err) {
    const count = await this.redis.incr(attemptsKey);
    await this.redis.expire(attemptsKey, this.constants.STEP_UP_RATE_WINDOW_SECONDS);
    if (count >= this.constants.STEP_UP_MAX_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + this.constants.STEP_UP_RATE_WINDOW_SECONDS * 1000);
      await this.sessionRepo.setStepUpLockedUntil(deviceSessionId, lockedUntil);
      await this.cacheInvalidator.invalidate(deviceSessionId);
    }
    throw err;
  }

  // Success
  await this.redis.del(attemptsKey);
  const now        = new Date();
  const window     = dto.intendedWindowSeconds ?? this.constants.STEP_UP_VALIDITY_SECONDS;
  const validUntil = new Date(now.getTime() + window * 1000);
  await this.sessionRepo.updateStepUp(deviceSessionId, dto.method, now);
  await this.cacheInvalidator.invalidate(deviceSessionId);

  return { ok: true, method: dto.method, completedAt: now, validUntil };
}

private async verifyMethod(phone: string, publicKey: string, dto: StepUpDto): Promise<void> {
  switch (dto.method) {
    case 'otp_sms': {
      if (!dto.otpRequestId) throw new AppException(ErrorCodes.VALIDATION_FAILED, 'otp_request_id required', 422);
      const req = await this.otpRepo.findActiveRequest(dto.otpRequestId, phone);
      if (!req) throw new AppException(ErrorCodes.TOKEN_EXPIRED, 'OTP_EXPIRED', 422);
      await this.otpService.verifyOtp(phone, dto.credential, req);
      break;
    }
    case 'biometric': {
      if (!dto.challengeId) throw new AppException(ErrorCodes.VALIDATION_FAILED, 'challenge_id required', 422);
      await this.challenge.consumeChallenge(dto.challengeId);
      const ok = await this.crypto.verifyDeviceSignature(publicKey, dto.challengeId, dto.credential);
      if (!ok) throw new UnauthorizedException('DEVICE_SIGNATURE_INVALID');
      break;
    }
    default:  // totp / password_reentry are not implemented
      throw new AppException(ErrorCodes.VALIDATION_FAILED, 'Unsupported step-up method', 422);
  }
}
```

---

## 6. Store Endpoints

Controller: `StoreController` — base path `stores`. Guard: `MobileJwtGuard` only (account-level action, `@StoreContext('none')`).

### 13. POST `/api/stores` — Create a store

- **Auth:** JWT · **Success status:** `200/201`
- **Service:** `StoreService.createStore(userId, input)`

**Request body** (`CreateStoreDto`)
```json
{
  "name": "My Shop",
  "gst_number": "22AAAAA0000A1Z5",
  "address": "12 Market Rd",
  "phone": "+919876543210",
  "email": "shop@example.com"
}
```
- `name`: 1–120 (required). `gst_number`/`phone`: ≤20. `address`: ≤500. `email`: valid email. All except `name` optional.

**Functionality**
1. Verify caller is **account owner** → else `403 not_account_owner`.
2. Check `max_stores` entitlement vs active store count → at limit → `403 store_limit_reached`.
3. **Transaction:** insert store; create immutable `STORE_OWNER` role; seed full owner permissions; assign creator to `STORE_OWNER`; if first store & subscription `trialing` & `hasUsedTrial=false` → start 14-day trial; bump creator's permissions version (invalidates cached JWTs).
4. Invalidate user store cache. Audit `STORE_CREATED` + `ROLE_ASSIGNMENT_CREATED`.

**Response `data`**
```json
{ "id": "uuid", "name": "My Shop" }
```

**Errors:** `403 not_account_owner`, `403 store_limit_reached`.

**Service code — `StoreService.createStore`** (`store.service.ts`)
```ts
async createStore(userId: string, input: CreateStoreInput): Promise<CreatedStore> {
  // Ownership gate — only the account owner may create stores.
  const account = await this.repo.findOwnedAccount(userId);
  if (!account) throw new ForbiddenException('NOT_ACCOUNT_OWNER');

  // max_stores gate. Locked stores don't count.
  const limit  = await this.entitlements.get(account.id, 'max_stores');
  const active = await this.repo.countActiveStores(account.id);
  if (!this.entitlements.canCreate(limit, active)) {
    throw new ForbiddenException('STORE_LIMIT_REACHED');
  }

  const created = await this.uow.execute(async (tx) => {
    const isFirstStore = !(await this.repo.hasAnyStore(account.id, tx));

    const store = await this.repo.insertStore({
      accountFk: account.id, name: input.name, gstNumber: input.gstNumber,
      address: input.address, phone: input.phone, email: input.email,
    }, tx);

    // Per-store immutable STORE_OWNER role, fully granted, assigned to creator.
    const ownerRole = await this.repo.insertStoreOwnerRole(store.id, tx);
    await this.rbac.seedStoreOwnerPermissions(ownerRole.id, userId, tx);
    await this.repo.insertRoleMapping(
      { userFk: userId, roleFk: ownerRole.id, storeFk: store.id, assignedBy: userId }, tx);

    // First store opens the trial window.
    if (isFirstStore) {
      const sub = await this.repo.findSubscription(account.id, tx);
      if (sub && sub.status === 'trialing' && !sub.hasUsedTrial) {
        const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);  // 14 days
        await this.repo.startTrial(sub.id, trialEndsAt, tx);
      }
    }

    // Bump so a stale JWT re-bootstraps and picks up the new store role (H-6).
    await this.repo.bumpUserPermissionsVersion(userId, tx);
    return store;
  });

  await this.rbac.invalidateUserStoreCache(userId, created.id);
  await this.audit.log({
    event: 'STORE_CREATED', activityType: 'ROLE_ASSIGNMENT_CREATED',
    prefix: 'Store', suffix: `created and STORE_OWNER assigned`,
    userId, storeFk: created.id, isSuccess: true, entityType: 'Store', entityId: created.id,
  });

  return { id: created.id, name: created.name };
}
```

---

## 7. Role Endpoints

Controller: `RoleController` — base path `stores/:storeId/roles`.
Guards: `MobileJwtGuard → TenantGuard → PermissionsGuard`; `@StoreContext('param.storeId')` class-wide.
Service: `RoleService`.

### 14. GET `/api/stores/:storeId/roles` — List roles

- **RBAC:** `Role:view` · **Status:** `200`
- **Service:** `listRoles(storeId)` — returns all system + custom roles in the store (empty array if none).

**Response `data`:** array of role records (id, code/name, `isEditable`, …).

**Service code — `RoleService.listRoles`** (`role.service.ts`)
```ts
async listRoles(storeId: string) {
  return this.repo.listStoreRoles(storeId);   // system + custom roles; [] if none
}
```

---

### 15. POST `/api/stores/:storeId/roles` — Create custom role

- **RBAC:** `Role:create` · **Status:** `200/201`
- **Service:** `createRole(storeId, actorId, name, description)`

**Request body** (`CreateRoleDto`)
```json
{ "name": "Cashier", "description": "Handles billing" }
```
- `name`: 1–100. `description`: ≤500, optional.

**Functionality:** reject duplicate name → `409 role_already_exists`; **transaction** insert custom (editable) role + seed default CRUD permissions; audit `ROLE_PERMISSION_CHANGED`.

**Response `data`**
```json
{ "id": "uuid", "name": "Cashier" }
```

**Errors:** `409 role_already_exists`.

**Service code — `RoleService.createRole`** (`role.service.ts`)
```ts
async createRole(storeId: string, actorId: string, name: string, description: string | null) {
  if (await this.repo.nameTaken(storeId, name)) throw new ConflictException('ROLE_ALREADY_EXISTS');

  const role = await this.uow.execute(async (tx) => {
    const r = await this.repo.createCustomRole(storeId, name, description, tx);
    await this.rbac.seedDefaultPermissions(r.id, actorId, tx);   // DEFAULT_ROLE_CRUD
    return r;
  });

  await this.audit.log({
    event: 'ROLE_PERMISSION_CHANGED', activityType: 'ROLE_PERMISSION_CHANGED',
    prefix: 'Role', suffix: `"${name}" created`,
    userId: actorId, storeFk: storeId, isSuccess: true, entityType: 'Role', entityId: role.id,
  });
  return { id: role.id, name };
}
```

---

### 16. PATCH `/api/stores/:storeId/roles/:roleId/permissions` — Replace role permissions

- **RBAC:** `Role:edit` · **Status:** `204`
- **Service:** `updatePermissions(storeId, actorId, roleId, permissions)`

**Request body** (`UpdatePermissionsDto`)
```json
{
  "permissions": [
    { "entity": "Product", "action": "view" },
    { "entity": "Product", "action": "create" }
  ]
}
```
- `permissions`: ≤200 items; `action` ∈ `view|create|edit|delete`.

**Functionality:** role must exist in store → `404 role_not_found`; must be editable → system role → `403 role_not_editable`; filter to valid entity codes; **transaction** revoke existing grants → insert new grants (`grantedBy=actorId`) → bump permissions version for **all role members** (invalidates their JWTs); invalidate members' cache; audit `ROLE_PERMISSION_CHANGED`.

**Response:** `204 No Content`. **Errors:** `404 role_not_found`, `403 role_not_editable`.

**Service code — `RoleService.updatePermissions`** (`role.service.ts`)
```ts
async updatePermissions(storeId: string, actorId: string, roleId: string, grants: PermissionGrantInput[]): Promise<void> {
  const role = await this.repo.findRoleInStore(roleId, storeId);
  if (!role)            throw new NotFoundException('ROLE_NOT_FOUND');
  if (!role.isEditable) throw new ForbiddenException('ROLE_NOT_EDITABLE');

  const clean = grants.filter((g) => isEntityCode(g.entity));

  const members = await this.uow.execute(async (tx) => {
    await this.repo.revokeAllCrud(roleId, tx);
    await this.repo.insertCrud(
      clean.map((g) => ({ roleFk: roleId, entityCode: g.entity, action: g.action, grantedBy: actorId })), tx);
    // Bump every member's version so their cache/JWT re-resolve (H-6).
    return this.rbac.bumpPermissionsVersionForRole(roleId, storeId, tx);
  });

  await this.rbac.invalidateRoleMembersCache(roleId, storeId);
  await this.audit.log({
    event: 'ROLE_PERMISSION_CHANGED', activityType: 'ROLE_PERMISSION_CHANGED',
    prefix: 'Role', suffix: `permissions updated (${members.length} members)`,
    userId: actorId, storeFk: storeId, isSuccess: true, entityType: 'Role', entityId: roleId,
  });
}
```

---

### 17. DELETE `/api/stores/:storeId/roles/:roleId` — Delete custom role

- **RBAC:** `Role:delete` · **Status:** `204`
- **Service:** `deleteRole(storeId, actorId, roleId)`

**Functionality:** role must exist → `404 role_not_found`; must be editable → `403 role_not_editable`; must have **no active members** → `409 role_has_active_assignments`; soft-delete; audit `ROLE_PERMISSION_CHANGED`.

**Response:** `204 No Content`. **Errors:** `404 role_not_found`, `403 role_not_editable`, `409 role_has_active_assignments`.

**Service code — `RoleService.deleteRole`** (`role.service.ts`)
```ts
async deleteRole(storeId: string, actorId: string, roleId: string): Promise<void> {
  const role = await this.repo.findRoleInStore(roleId, storeId);
  if (!role)            throw new NotFoundException('ROLE_NOT_FOUND');
  if (!role.isEditable) throw new ForbiddenException('ROLE_NOT_EDITABLE');
  if ((await this.repo.countActiveMembers(roleId)) > 0) {
    throw new ConflictException('ROLE_HAS_ACTIVE_ASSIGNMENTS');
  }
  await this.repo.softDeleteRole(roleId);
  await this.audit.log({
    event: 'ROLE_PERMISSION_CHANGED', activityType: 'ROLE_PERMISSION_CHANGED',
    prefix: 'Role', suffix: `"${role.name}" deleted`,
    userId: actorId, storeFk: storeId, isSuccess: true, entityType: 'Role', entityId: roleId,
  });
}
```

---

### 18. POST `/api/stores/:storeId/roles/:roleId/assign` — Assign role to user

- **RBAC:** `UserRoleMapping:create` · **Status:** `204`
- **Service:** `assignRole(storeId, actorId, roleId, targetUserId)`

**Request body** (`AssignRoleDto`)
```json
{ "user_id": "uuid" }
```

**Functionality:** role exists → `404 role_not_found`; not a system role → `403 role_not_assignable`; target is an account member of the store → else `403 user_not_store_member`; not already assigned → `409 assignment_already_exists`; **transaction** insert assignment + bump role permissions version; invalidate target's store cache; audit `ROLE_ASSIGNMENT_CREATED`.

**Response:** `204 No Content`. **Errors:** `404 role_not_found`, `403 role_not_assignable`, `403 user_not_store_member`, `409 assignment_already_exists`.

**Service code — `RoleService.assignRole`** (`role.service.ts`)
```ts
async assignRole(storeId: string, actorId: string, roleId: string, targetUserId: string): Promise<void> {
  const role = await this.repo.findRoleInStore(roleId, storeId);
  if (!role) throw new NotFoundException('ROLE_NOT_FOUND');
  if (SYSTEM_ROLE_CODES.has(role.code)) throw new ForbiddenException('ROLE_NOT_ASSIGNABLE');
  if (!(await this.repo.isAccountMember(targetUserId, storeId))) throw new ForbiddenException('USER_NOT_STORE_MEMBER');
  if (await this.repo.assignmentExists(targetUserId, roleId, storeId)) throw new ConflictException('ASSIGNMENT_ALREADY_EXISTS');

  await this.uow.execute(async (tx) => {
    await this.repo.insertAssignment(
      { userFk: targetUserId, roleFk: roleId, storeFk: storeId, assignedBy: actorId }, tx);
    await this.rbac.bumpPermissionsVersionForRole(roleId, storeId, tx);
  });
  await this.rbac.invalidateUserStoreCache(targetUserId, storeId);
  await this.audit.log({
    event: 'ROLE_ASSIGNMENT_CREATED', activityType: 'ROLE_ASSIGNMENT_CREATED',
    prefix: 'Role', suffix: `assigned "${role.name}"`,
    userId: actorId, actorId, storeFk: storeId, isSuccess: true,
    entityType: 'UserRoleMapping', metadata: { targetUserId, roleId },
  });
}
```

---

### 19. DELETE `/api/stores/:storeId/roles/:roleId/members/:userId` — Revoke role from user

- **RBAC:** `UserRoleMapping:delete` · **Status:** `204`
- **Service:** `revokeRole(storeId, actorId, roleId, targetUserId)`

**Functionality:** **transaction** revoke assignment → if none revoked → `404 assignment_not_found`; else bump role permissions version; invalidate target's store cache; audit `ROLE_ASSIGNMENT_REVOKED`.

**Response:** `204 No Content`. **Errors:** `404 assignment_not_found`.

**Service code — `RoleService.revokeRole`** (`role.service.ts`)
```ts
async revokeRole(storeId: string, actorId: string, roleId: string, targetUserId: string): Promise<void> {
  const revoked = await this.uow.execute(async (tx) => {
    const ok = await this.repo.revokeAssignment(targetUserId, roleId, storeId, tx);
    if (ok) await this.rbac.bumpPermissionsVersionForRole(roleId, storeId, tx);
    return ok;
  });
  if (!revoked) throw new NotFoundException('ASSIGNMENT_NOT_FOUND');

  await this.rbac.invalidateUserStoreCache(targetUserId, storeId);
  await this.audit.log({
    event: 'ROLE_ASSIGNMENT_REVOKED', activityType: 'ROLE_ASSIGNMENT_REVOKED',
    prefix: 'Role', suffix: `revoked`,
    userId: actorId, actorId, storeFk: storeId, isSuccess: true,
    entityType: 'UserRoleMapping', metadata: { targetUserId, roleId },
  });
}
```

---

## 8. Invitation Endpoints

### 20. POST `/api/stores/:storeId/invitations` — Create staff invitation

- Controller: `StoreInvitationController` — base path `stores/:storeId/invitations`.
- Guards: `MobileJwtGuard → TenantGuard → PermissionsGuard`; `@StoreContext('param.storeId')`.
- **RBAC:** `Invitation:create` · **Status:** `200/201`
- **Service:** `InvitationService.create(storeId, accountId, actorId, input)`

**Request body** (`CreateInvitationDto`)
```json
{ "role_id": "uuid", "phone": "+919876543210", "email": "staff@example.com" }
```
- `role_id`: required UUID. `phone` (≤20) or `email` (valid) — **at least one required**.

**Functionality:** require phone or email → `409 invitation_contact_required`; role must exist in store → `404 role_not_found`; must be **custom** (not system) → `403 role_not_assignable`; check `max_users_per_store` vs active staff → at limit → `403 user_limit_reached`; generate 24-byte base64url token; `expiresAt = now + 7 days`; insert invitation (`status=pending`); audit `ROLE_ASSIGNMENT_CREATED`. *(SMS/email delivery is deferred — TODO.)*

**Response `data`**
```json
{ "id": "uuid", "token": "base64url-token" }
```

**Errors:** `409 invitation_contact_required`, `404 role_not_found`, `403 role_not_assignable`, `403 user_limit_reached`.

**Service code — `InvitationService.create`** (`invitation.service.ts`)
```ts
async create(storeId: string, accountId: string, actorId: string, input: CreateInvitationInput): Promise<{ id: string; token: string }> {
  if (!input.phone && !input.email) throw new ConflictException('INVITATION_CONTACT_REQUIRED');

  // Only custom roles of this store are invitable.
  const role = await this.roleRepo.findRoleInStore(input.roleId, storeId);
  if (!role) throw new NotFoundException('ROLE_NOT_FOUND');
  if (SYSTEM_ROLE_CODES.has(role.code)) throw new ForbiddenException('ROLE_NOT_ASSIGNABLE');

  // max_users_per_store gate.
  const limit  = await this.entitlements.get(accountId, 'max_users_per_store');
  const active = await this.repo.countActiveStaff(storeId);
  if (!this.entitlements.canCreate(limit, active)) throw new ForbiddenException('USER_LIMIT_REACHED');

  const token     = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);  // 7 days

  const invitation = await this.repo.create({
    storeFk: storeId, roleFk: input.roleId, phone: input.phone, email: input.email,
    token, invitedBy: actorId, expiresAt,
  });

  // TODO: deliver the invite (SMS via Msg91 / email) — record + token exist now.

  await this.audit.log({
    event: 'ROLE_ASSIGNMENT_CREATED', activityType: 'ROLE_ASSIGNMENT_CREATED',
    prefix: 'Invitation', suffix: `created for role "${role.name}"`,
    userId: actorId, storeFk: storeId, isSuccess: true, entityType: 'Invitation', entityId: invitation.id,
  });
  return invitation;   // { id, token }
}
```

---

### 21. POST `/api/invitations/accept` — Accept an invitation

- Controller: `InvitationController` — base path `invitations`. Guard: `MobileJwtGuard`.
- **Status:** `200/201`
- **Service:** `InvitationService.accept(token, userId)`

**Request body** (`AcceptInvitationDto`)
```json
{ "token": "base64url-token" }
```

**Functionality:** load by token → missing → `404 invitation_not_found`; must be `pending` → `409 invitation_not_pending`; not expired → `403 invitation_expired`; **transaction** ensure account membership (idempotent) + assign role in store + mark `accepted` (`acceptedBy=userId`) + bump role permissions version; invalidate user store cache; audit `ROLE_ASSIGNMENT_CREATED`.

**Response `data`**
```json
{ "storeId": "uuid" }
```

**Errors:** `404 invitation_not_found`, `409 invitation_not_pending`, `403 invitation_expired`.

**Service code — `InvitationService.accept`** (`invitation.service.ts`)
```ts
async accept(token: string, userId: string): Promise<{ storeId: string }> {
  const invitation = await this.repo.findByToken(token);
  if (!invitation)                       throw new NotFoundException('INVITATION_NOT_FOUND');
  if (invitation.status !== 'pending')   throw new ConflictException('INVITATION_NOT_PENDING');
  if (invitation.expiresAt < new Date()) throw new ForbiddenException('INVITATION_EXPIRED');

  await this.uow.execute(async (tx) => {
    await this.repo.ensureAccountMembership(userId, invitation.storeFk, tx);        // idempotent
    await this.repo.assignRole(userId, invitation.roleFk, invitation.storeFk, userId, tx);
    await this.repo.markAccepted(invitation.id, userId, tx);
    await this.rbac.bumpPermissionsVersionForRole(invitation.roleFk, invitation.storeFk, tx);
  });
  await this.rbac.invalidateUserStoreCache(userId, invitation.storeFk);

  await this.audit.log({
    event: 'ROLE_ASSIGNMENT_CREATED', activityType: 'ROLE_ASSIGNMENT_CREATED',
    prefix: 'Invitation', suffix: `accepted`,
    userId, storeFk: invitation.storeFk, isSuccess: true,
    entityType: 'UserRoleMapping', metadata: { invitationId: invitation.id, roleId: invitation.roleFk },
  });
  return { storeId: invitation.storeFk };
}
```

---

## 9. Utility Endpoints

### 22. GET `/api/` — Hello API

- Controller: `AppController`. Public. Returns `AppService.getData()`.

**Service code — `AppService.getData`** (`app.service.ts`)
```ts
getData(): { message: string } {
  return { message: 'Hello API' };
}
```

**Response `data`**
```json
{ "message": "Hello API" }
```

### 23. GET `/health` — Health check

- Controller: `HealthController`. Public, `@SkipThrottle()`, **no `/api` prefix**.
- Uses `@nestjs/terminus`: database (Drizzle), memory heap (≤250 MB), memory RSS (≤512 MB), disk (≤90% of `/`).

**Controller code — `HealthController.check`** (`health.controller.ts`)
```ts
@Get()
@HealthCheck()
check() {
  return this.health.check([
    () => this.db.isHealthy('database'),
    () => this.memory.checkHeap('memory_heap', 250 * 1024 * 1024),
    () => this.memory.checkRSS('memory_rss',   512 * 1024 * 1024),
    () => this.disk.checkStorage('disk', { thresholdPercent: 0.9, path: '/' }),
  ]);
}
```

**Response** (Terminus format, unwrapped):
```json
{
  "status": "ok",
  "info":  { "database": { "status": "up" }, "memory_heap": { "status": "up" }, "memory_rss": { "status": "up" }, "disk": { "status": "up" } },
  "error": {},
  "details": { "...": "per-indicator" }
}
```
Unhealthy → `503 Service Unavailable`.

---

## 10. Entitlement Limits Reference

Enforced by `EntitlementService` (plan → `plan_entitlements`). `null` value = **unlimited**; check is strict `current < limit`.

| Key | Enforced on |
|---|---|
| `max_stores` | `POST /stores` |
| `max_users_per_store` | `POST /stores/:storeId/invitations` |
| `max_locations_per_store` | (reserved) |
| `max_devices_per_store` | (reserved) |
| `max_products` | (reserved) |

Feature flags (`plan_features`) resolved via `EntitlementService.feature(accountId, key)` (missing row = `false`).

### Trial lifecycle (single owner: first-store-create)

The 14-day trial window has **exactly one owner — first store creation** — despite two flows touching the subscription:

| Flow | `status` | `trial_ends_at` | `access_valid_until` | `has_used_trial` |
|---|---|---|---|---|
| **Signup** (`AccountBootstrapService.bootstrap`) | `trialing` | `null` | `null` | `false` |
| **First store** (`StoreService.createStore` → `StoreRepository.startTrial`) | `trialing` | `now + 14d` | `now + 14d` | `true` |

- Signup provisions a **dormant** `trialing` subscription with **no window** — it does *not* start the clock or flip `has_used_trial`.
- The trial clock starts **only** at first store-create: `startTrial` is the sole writer of `trial_ends_at` / `access_valid_until` / `has_used_trial`. The `createStore` guard (`status === 'trialing' && !has_used_trial`) is therefore live, not dead code.
- A user who signs up but never creates a store remains in `trialing` with a null window indefinitely (intentional — no store means nothing to gate; `SubscriptionStatusGuard` passes a null `access_valid_until` while `status = 'trialing'`).

---

*Generated from source: `apps/backend/src` — controllers, DTOs (Zod), response types, full service implementations, guards, and `apply-global-config.ts`. Each endpoint includes its backing service method's actual source; repository/RBAC helpers (e.g. `*.repository.ts`, `RbacService`, `CryptoService`, `AuditService`) are referenced by call site rather than inlined.*
