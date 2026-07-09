# QA Test-Case Set — Mobile Auth

**Module:** Mobile app authentication (`apps/backend/src/auth/mobile/**`)
**Mode:** QA (read from implementation) + BA (requirements reconstructed from code/comments)
**Scope:** login (OTP), signup (OTP), logout / logout-all, session listing & revocation, refresh-token
rotation + device-proof challenge, step-up re-auth, `MobileJwtGuard`, `SubscriptionStatusGuard`.

Source files read: `mobile-auth.controller.ts`, `me.controller.ts`, all of `services/*`,
`guards/*`, `mappers/*`, `dto/request|response/*`, `types/*`, `repositories/*`,
`interceptors/snapshot-refresh.interceptor.ts`, `core/crypto.service.ts`, `core/rate-limit.service.ts`,
`config/env.ts` / `app-config.service.ts`, `common/error-codes.ts`,
`subscription/subscription-cache.ts` (guard dependency).

---

## 1. Feature understanding (BA)

### 1.1 What it does

The mobile app authenticates cashiers/managers per store via **phone + OTP** (no passwords). A
successful login/signup issues a short-lived **access JWT** (15 min) and a long-lived, rotating,
**device-bound refresh token** (30 days), plus a signed **permission snapshot** used for offline
authorization. Every request to a protected mobile route is gated by `MobileJwtGuard`; mutating
requests on tenant-scoped routes are additionally gated by `SubscriptionStatusGuard`.

### 1.2 Actors

- **Unauthenticated caller** — anyone hitting `login/otp`, `login/verify`, `signup/otp`,
  `signup/verify`, `refresh/challenge`, `refresh` (all `@Public()`).
- **Authenticated principal (`MobilePrincipal`)** — cashier/manager/owner with a valid access token;
  hits `logout`, `logout/all`, `sessions`, `sessions/:id` (DELETE), `step-up/*`.
- **Attacker** — phone-number guesser, stolen-device holder, stolen-refresh-token holder, replay
  attacker, concurrent-request racer.
- **The system** — Redis (rate limits, OTP codes, caches, idempotency, challenges, blacklist),
  Postgres (durable state), MSG91 (SMS gateway), cron jobs (token cleanup, out of scope here).

### 1.3 Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/mobile/login/otp` | Public | `@Throttle 5/60s` |
| POST | `/auth/mobile/login/verify` | Public | `@Throttle 10/60s` |
| POST | `/auth/mobile/signup/otp` | Public | `@Throttle 5/60s` |
| POST | `/auth/mobile/signup/verify` | Public | `@Throttle 10/60s`, 201 |
| POST | `/auth/mobile/refresh/challenge` | Public | keyed by refresh token itself |
| POST | `/auth/mobile/refresh` | Public | device-bound rotation |
| POST | `/auth/mobile/logout` | JWT | 204 |
| POST | `/auth/mobile/logout/all` | JWT | 204 |
| GET | `/auth/mobile/sessions` | JWT | cursor page, `SnapshotRefreshInterceptor` |
| DELETE | `/auth/mobile/sessions/:id` | JWT | revoke one session |
| POST | `/auth/mobile/step-up/challenge` | JWT | biometric challenge |
| POST | `/auth/mobile/step-up/otp` | JWT | OTP for step-up (own phone only) |
| POST | `/auth/mobile/step-up/verify` | JWT | otp_sms or biometric |

### 1.4 Exact numeric constants (from `env.ts` defaults / `app-config.service.ts`)

| Constant | Value | Effect |
|---|---|---|
| `OTP_TTL_SECONDS` | 300 (5 min) | OTP code + DB request row validity |
| `OTP_RESEND_COOLDOWN_SECONDS` | 60 | min gap between `resend_of` calls |
| `OTP_MAX_ATTEMPTS` | 5 | (a) wrong-code attempts per OTP request, **and** (b) per-phone `rl:otp:{phone}` counter limit (see §1.6) |
| `IP_MAX_ATTEMPTS` | 100 / 60s | `rl:ip:{ip}` — shared across OTP-request + verify calls from that IP |
| OTP request-lock | 5s NX | `otp_lock:{phone}:{purpose}` — blocks a second `requestOtp` call inside 5s regardless of resend intent |
| `DEVICE_CHALLENGE_TTL_SECONDS` | 300 (5 min) | refresh/step-up biometric challenge validity, single-use (GETDEL) |
| `SESSION_CACHE_TTL_SECONDS` | 30 | Redis session / device-status / user-status cache TTL |
| `REFRESH_TOKEN_TTL_SECONDS` | 2,592,000 (30 days) | refresh token **and** session row expiry |
| `ACCESS_TOKEN_TTL_SECONDS` | 900 (15 min) | JWT `exp` |
| `SNAPSHOT_CACHE_TTL_SECONDS` | 604,800 (7 days) | permission snapshot cache |
| `STEP_UP_VALIDITY_SECONDS` | 300 (5 min, unless caller requests a different `intended_window_seconds`, capped 1–3600) | step-up freshness window |
| `STEP_UP_RATE_WINDOW_SECONDS` / `STEP_UP_MAX_ATTEMPTS` | 300 / 5 | 5 failed step-ups in 5 min → session-level step-up lock for the next 5 min |
| `MAX_FAILED_LOGIN_ATTEMPTS` / `ACCOUNT_LOCKOUT_DURATION_MINUTES` | 5 / 30 | 5 failed OTP verifies at **login** → account locked 30 min |
| Refresh reuse-grace (`REUSE_GRACE_MS`) | 30s | a used-token replay within 30s of `usedAt` is treated as a concurrent-retry race, not theft |
| Refresh idempotency cached-recovery window | 600s (10 min) | `REFRESH_IDEM_DONE_TTL_SECONDS` |
| Refresh idempotency PENDING lock | 15s | leader-death bound |
| Idempotency poll | 200ms interval, 3s timeout | follower behavior while leader rotates |
| Replay-protection timestamp drift | ±30s | `x-timestamp` header |
| Replay-protection nonce TTL | 600s (10 min) | `x-nonce` header, one-time use |
| Sessions list `limit` | default 20, max 100, ≤0/NaN → 20 | `clampLimit` |

### 1.5 Business rules / invariants extracted from code

- **BR-1 Phone-enumeration resistance:** an unregistered phone gets an identical `login/otp`
  response (fake `otpRequestId`, no OTP sent, no DB row) to a registered one; the follow-up `verify`
  fails as `OTP_EXPIRED` either way.
- **BR-2 OTP purpose isolation:** an OTP minted for `login` cannot verify a `signup` or `step_up`
  request and vice-versa (`findActiveRequest` filters on `purpose`).
- **BR-3 OTP is single-use:** `markConsumed` is set on success; a second verify with the same code
  returns `OTP_ALREADY_CONSUMED` (`TOKEN_INVALID`, 422).
- **BR-4 OTP attempt cap:** 5 wrong codes against the same `otp_request_id` → `OTP_MAX_ATTEMPTS`
  (`TOKEN_INVALID`, 422), enforced atomically in the `WHERE` clause (race-safe).
- **BR-5 Signup order-of-checks:** OTP is verified *before* the "does this phone already have an
  account" check, so a caller without a valid OTP can never learn account existence (closes the old
  409-vs-422 oracle).
- **BR-6 Account lockout (login only):** 5 failed OTP verifies at `login/verify` locks the account for
  30 minutes (`ACCOUNT_LOCKED`, 429); signup failures never lock (no account exists yet); step-up
  failures never touch this counter (only the session-level step-up lock, BR-16).
- **BR-7 Blocked/suspended accounts reject login even with a correct OTP** (`USER_BLOCKED` 403,
  `USER_SUSPENDED` 403) — phone possession is not sufficient once an admin has blocked/suspended.
- **BR-8 A successful login clears the failed-attempt lockout** (`failedLoginAttempts=0`,
  `accountLockedUntil=null`) and flips `status` back to `active` **unless** it is `suspended` (admin
  suspension is never auto-cleared by a login).
- **BR-9 Device identity is keyed by `sha256(publicKey)` per user** — the same key-pair reused
  across logins reuses the same `devices` row (updates `lastSeenAt`/`appVersion`/etc.); a new
  key-pair is a new device.
- **BR-10 A session is blacklist-able from the instant it's minted** — `currentJti`/`currentJtiExp`
  are stamped in the same transaction as session creation, so a device revoked before its first
  refresh can still be killed immediately.
- **BR-11 Refresh tokens rotate on every use and are single-use** — reuse of an already-used token
  (outside the 30s race-grace) revokes the **entire token family**, forcing full re-login even for
  the legitimately-current, unused successor token in that family.
- **BR-12 Refresh requires device proof (challenge + Ed25519 signature) unless the device is
  `is_trusted`** — devices are created untrusted; there is currently no code path that sets
  `is_trusted=true` (Phase 1). So in practice every refresh must supply a valid challenge+signature.
- **BR-13 A stale/mismatched `currentJti` on the session forcibly logs the caller out** — if a
  refresh rotation's best-effort blacklist write fails but the DB `currentJti` was still stamped,
  the superseded access token is rejected by `MobileJwtGuard` as `SESSION_REPLACED`.
- **BR-14 Logout releases device-held store slots; single-session revoke does not.**
  `AuthLogoutService.logout()` calls `deviceAccess.revokeAllSlotsForDevice`; `revokeSession()` (used
  to kill a *different* device from the current one) does not touch slots at all — see Open
  Questions §7.
- **BR-15 `logout/all` blacklists every session's `currentJti`, revokes every refresh token and every
  session for the user, and invalidates every cached session**, in one atomic DB transaction plus a
  best-effort cache sweep.
- **BR-16 Step-up failures are rate-limited per session (not per user):** 5 failures in 5 minutes
  locks *that session* from further step-up attempts for 5 minutes (`STEP_UP_LOCKED`, 429);
  independent of the account-level login lockout.
- **BR-17 Step-up OTP always targets the caller's own registered phone** — a client-supplied phone
  in the step-up-OTP request body is validated for shape but silently ignored.
- **BR-18 Every authenticated (guarded) request requires `x-timestamp` + `x-nonce` headers**
  (`ReplayProtectionService`), not just refresh — missing/stale/reused headers → `REPLAY_DETECTED`.
- **BR-19 `SubscriptionStatusGuard` never blocks reads** (GET/HEAD/OPTIONS) and never blocks a
  handler decorated `@AllowExpiredSubscription()`; it blocks writes on: admin `paused` (403
  `SUBSCRIPTION_SUSPENDED`), `expired` status (402 `SUBSCRIPTION_PAYMENT_REQUIRED`), access window
  closed even if status hasn't flipped yet (402, same code), pending reconciliation (403
  `SUBSCRIPTION_RECONCILIATION_REQUIRED`), or a locked store (403 `STORE_LOCKED`). None of the
  mobile-auth endpoints themselves are store-scoped, so this guard never sits directly on
  login/signup/refresh/logout/sessions — it gates *other* tenant-scoped mobile routes mid-session.
- **BR-20 Snapshot delivery is best-effort everywhere it appears** (login, signup, refresh,
  `SnapshotRefreshInterceptor` on `/sessions`) — a build failure degrades to `snapshot: null` /
  `snapshot_changed: false`, never fails the parent operation.

### 1.6 Notable ambiguity flagged up front

`checkPhoneOtpLimit` uses a **single Redis key `rl:otp:{phone}`** (not purpose-scoped) with a
300-second window and a limit equal to `OTP_MAX_ATTEMPTS` (5) — and it is incremented on *every*
call site: `requestOtp` (login-otp, signup-otp), `loginStageTwo`, `signupStageTwo`, and
`StepUpService.verifyMethod`. That means **5 total OTP-related actions per phone per 5 minutes,
summed across login+signup+step-up, request+verify combined** — not "5 wrong-code guesses". A
legitimate user who requests an OTP, mistypes it twice, requests a resend, and retries could hit
`RATE_LIMIT_EXCEEDED` well before hitting `OTP_MAX_ATTEMPTS`. Flagged as Open Question §7-Q1.

### 1.7 State machines

**OTP request:** `created (unconsumed, attempts=0)` → `verify success → consumedAt set (terminal)`
| `verify wrong code × N< max → attempts++` | `verify wrong code, attempts==max → OTP_MAX_ATTEMPTS
(terminal-ish; a fresh request/resend is required)` | `expiresAt passed → OTP_EXPIRED (terminal)`.

**User account (login-relevant fields):** `active` → (5 failed OTP verifies) → `locked +
accountLockedUntil=T+30m` → (successful login, any time, even before T) → `active` (BR-8: only the
timestamp gate is checked at login, not the `status` field) . Independently: `active`/`locked` →
(admin) → `suspended` (never auto-cleared).

**Device session:** `created (currentJti=J0)` → (refresh rotate) → `currentJti=J1, refreshToken
family advances` → … → `revoked (logout / logout-all / revokeSession / reuse-detected)` | `expiresAt
passed (30d)`.

**Refresh-token family:** `token0 (unused)` → (rotate) → `token0.usedAt set, token1 (unused, same
familyId)` → … If `token0` is replayed after `token1` exists and grace has elapsed: **entire family
revoked** (token1 included), including `token1` even if never used or compromised — theft response.

### 1.8 Assumptions used below

- "Registered phone" = a row exists in `users` with that phone.
- Redis and Postgres are both reachable unless a case explicitly tests degraded-dependency behavior.
- `NODE_ENV !== 'production'` in test environments, so OTP codes are logged, not SMS-sent
  (`Msg91Service` bypassed) — cases assume the tester can read the code from logs/test fixtures.
- "Device" = a public/private Ed25519 key pair on the physical device; "device signature" always
  refers to Ed25519 over the challenge string.

---

## 2. Coverage plan

| Dimension | Approx. cases |
|---|---|
| Happy paths | 10 |
| Business rules (satisfied + violated) | 34 |
| Boundaries | 16 |
| Negative / invalid input | 18 |
| Failure & recovery (dependency degradation) | 12 |
| Concurrency / races | 10 |
| Permissions / ownership | 6 |
| State transitions | 12 |
| Cross-cutting (offline/tenancy/time/replay) | 10 |
| UX | 4 |
| Edge-case checklist (dedicated §4) | 22 |
| **Total** | **~150** |

---

## 3. Test cases

### 3.1 Login — happy paths

**LOGIN-001 / Registered phone completes login end to end**
Area: happy · Criticality: Critical · Traces to: BR-1, core login flow
Preconditions: user row exists, phone `+919876543210`, status active, no lockout.
Input: `POST login/otp {phone}` then `POST login/verify {phone, otp_code, otp_request_id, device}`.
Steps: 1) request OTP, capture `otp_request_id`+dev-log code. 2) verify within 5 min with correct
code and valid device payload (Ed25519 public key, platform, app_version).
Expected: `login/otp` → 200 `{otp_sent:true, otp_request_id, expires_in:300}`. `login/verify` → 200
`LoginResponse` with `access_token`, `refresh_token`, `device_session_id`, non-null `snapshot` (or
null with graceful fallback), `pending_invitation_count`. New `devices` + `deviceSessions` +
`refreshTokens` rows created; `LOGIN_SUCCESS` audit entry written; `failedLoginAttempts` reset to 0.
Notes: verify session `expiresAt` = now + 30 days; access token `exp` = now + 15 min.

**LOGIN-002 / Resend OTP after cooldown, then verify with the resent code**
Area: happy · Criticality: High · Traces to: OTP resend flow
Preconditions: an existing `otp_request_id` from a prior `login/otp` call, ≥60s old.
Steps: `POST login/otp {phone, resend_of: <prior id>}` → new `otp_request_id`; verify with new code.
Expected: 200, new independent OTP row; old code (if resubmitted) now fails because the Redis
`otp:{phone}:login` key was overwritten by the newer code (see OTP-011).

**LOGIN-003 / Login on a second, different device creates a second independent session**
Area: happy · Criticality: High · Traces to: BR-9
Steps: log in with device A (key pair A), then again with device B (key pair B), same user.
Expected: two `devices` rows, two `deviceSessions` rows; `GET /sessions` lists both; each has its own
independent access/refresh token pair and can be revoked independently.

**LOGIN-004 / Re-login from the same device/key-pair reuses the device row**
Area: happy · Criticality: Medium · Traces to: BR-9
Steps: log out, then log in again from the same device (same public key).
Expected: same `devices.id` (matched by `publicKeyHash`), `lastSeenAt`/`appVersion` updated; a NEW
`deviceSessions` row is still created (sessions are per-login, devices are per-key-pair).

### 3.2 Login — business rules (satisfied + violated)

**LOGIN-010 / Unregistered phone returns identical stage-1 response (BR-1 satisfied)**
Area: rule · Criticality: Critical · Traces to: BR-1
Input: phone with no `users` row.
Expected: 200 `{otp_sent:true, otp_request_id:<random uuid>, expires_in:300}` — indistinguishable
from LOGIN-001's response shape/timing profile; no OTP row inserted, no SMS/log line emitted.

**LOGIN-011 / Verify against the unregistered-phone's fake otp_request_id fails uniformly**
Area: rule · Criticality: Critical · Traces to: BR-1
Steps: take the fake `otp_request_id` from LOGIN-010, call `login/verify` with any 6-digit code.
Expected: 422 `OTP_EXPIRED` — same code/shape as a genuinely lapsed request for a real phone
(REG-012), never a distinct "phone not found" signal.

**LOGIN-012 / Genuinely expired OTP on a registered phone → same OTP_EXPIRED**
Area: rule/boundary · Criticality: High
Steps: request OTP for a real phone, wait >300s (or manipulate `expiresAt` in test harness), verify.
Expected: 422 `OTP_EXPIRED`.

**LOGIN-013 / OTP minted for signup cannot verify a login (BR-2 violated case)**
Area: rule · Criticality: Critical · Traces to: BR-2
Steps: call `signup/otp` for a phone, then call `login/verify` with that `otp_request_id` + correct code.
Expected: 422 `OTP_EXPIRED` (repository filters by `purpose='login'`, finds nothing — the signup
request "doesn't exist" from login's point of view).

**LOGIN-014 / Blocked user cannot log in even with correct OTP (BR-7)**
Area: rule · Criticality: Critical
Preconditions: `users.isBlocked = true`.
Expected: 403 `USER_BLOCKED`; note the OTP is still consumed via `verifyOtp` running before the block
check is reached — confirm whether the code intends the block check *before* OTP consumption (see
Open Question §7-Q2: currently `isBlocked` is checked *before* `verifyOtp` is called in
`loginStageTwo`, so the OTP is NOT consumed on this path — verify this against the read: block/
suspend checks run prior to `rateLimit.checkPhoneOtpLimit`/`verifyOtp`, so the OTP remains valid for
a subsequent (still-blocked) attempt until it naturally expires).

**LOGIN-015 / Suspended user cannot log in even with correct OTP (BR-7)**
Area: rule · Criticality: Critical
Preconditions: `users.status = 'suspended'`.
Expected: 403 `USER_SUSPENDED`; OTP not consumed (same ordering as LOGIN-014).

**LOGIN-016 / Locked-out account rejects verify even with the correct code, before OTP checks**
Area: rule/state · Criticality: Critical · Traces to: BR-6
Preconditions: `accountLockedUntil` = now+10min (mid-lockout).
Expected: 429 `ACCOUNT_LOCKED`, message "Account temporarily locked due to too many failed
attempts"; OTP not consumed; rate-limit/attempt counters untouched (check runs before
`checkPhoneOtpLimit`).

**LOGIN-017 / Successful login exactly at accountLockedUntil boundary (lockout just expired)**
Area: boundary/state · Criticality: High · Traces to: BR-6, BR-8
Preconditions: `accountLockedUntil` = now − 1s (just passed).
Expected: login proceeds normally (only `accountLockedUntil > new Date()` is checked — strictly
future); success resets `failedLoginAttempts=0`, `accountLockedUntil=null`, `status='active'`.

**LOGIN-018 / 5th consecutive wrong OTP triggers lockout, 4th does not (BR-6 boundary)**
Area: boundary/rule · Criticality: Critical · Traces to: BR-6
Steps: submit 4 wrong codes across 4 separate `login/verify` calls (each against a *fresh* OTP
request so `OTP_MAX_ATTEMPTS`/BR-4 doesn't trip first), confirm still `ACCOUNT_LOCKED=false`
(can still attempt); on the 5th wrong OTP, confirm lockout applied.
Expected: attempts 1–4 → 422 `OTP_INVALID` with `attemptsRemaining` in `details`, account not locked;
attempt 5 → 422 `OTP_INVALID` **and** `failedLoginAttempts` reaches 5 → `accountLockedUntil` set to
+30 min; the very next login attempt (6th, even with correct code) → 429 `ACCOUNT_LOCKED`.

**LOGIN-019 / Login success mid-lockout-counter clears it (BR-8)**
Area: rule · Criticality: High
Steps: 2 wrong OTP attempts (failedLoginAttempts=2, no lockout yet), then 1 correct attempt.
Expected: login succeeds; `failedLoginAttempts` reset to 0 (not merely decremented).

**LOGIN-020 / Signup existence check unreachable without a valid OTP (BR-5)**
Area: rule · Criticality: High · Traces to: BR-5
Steps: call `signup/verify` for an already-registered phone, but with a wrong/garbage OTP code.
Expected: whatever `verifyOtp` throws (`OTP_INVALID`/`OTP_EXPIRED`/`OTP_MAX_ATTEMPTS`) — never
`USER_ALREADY_EXISTS`; the existence check must not be reachable before OTP is proven.

**LOGIN-021 / Signup existence check fires once OTP is proven (BR-5 satisfied path)**
Area: rule · Criticality: High
Steps: call `signup/otp` + `signup/verify` with the correct code for an already-registered phone.
Expected: 409 `USER_ALREADY_EXISTS` (`DUPLICATE_ENTRY`).

### 3.3 Signup

**SIGNUP-001 / Fresh phone completes signup end to end (happy)**
Area: happy · Criticality: Critical
Steps: `signup/otp` then `signup/verify {phone, otp_code, otp_request_id, name, device, consent_given:true}`.
Expected: 201, `LoginResponse` shape identical to login's; new `users` row (`phoneVerified:true`,
`primaryLoginMethod:'otp'`), account+membership+trialing subscription bootstrapped
(`accountBootstrap.bootstrap`), device+session+refresh token created, `SIGNUP` audit row,
`last_account_mode: null` (brand-new user has never picked a mode).

**SIGNUP-002 / consent_given must be literal true**
Area: negative/boundary · Criticality: Medium
Input: `consent_given: false` or omitted.
Expected: 422 `VALIDATION_FAILED` (Zod `z.literal(true)` rejects anything else) — request never
reaches the service layer.

**SIGNUP-003 / name boundary — empty string rejected, 100 chars accepted, 101 rejected**
Area: boundary · Criticality: Medium
Input: `name: ""` / `name: "A".repeat(100)` / `name: "A".repeat(101)`.
Expected: empty → 422 validation error (`min(1)`); 100 chars → accepted; 101 chars → 422.

**SIGNUP-004 / Concurrent signup for the same phone — DB unique constraint wins (race)**
Area: concurrency · Criticality: Critical · Traces to: `createUserAtomically` unique-violation handling
Steps: two clients both solve independent valid OTPs for the same never-before-seen phone
(possible if two OTP requests were issued before either verified) and call `signup/verify`
concurrently.
Expected: exactly one succeeds (201); the loser gets 409 `USER_ALREADY_EXISTS` (Postgres `23505` on
`users.phone` mapped by `unwrapPgError`), not a 500 or a generic conflict — same message shape as
SIGNUP's pre-check 409, so the client can't distinguish a race loss from an ordinary existence check.

**SIGNUP-005 / Signup session omits push_token even when device payload includes one**
Area: rule/negative (implementation gap) · Criticality: Medium
Steps: signup with `device.push_token` set; inspect the created `deviceSessions` row.
Expected (per code): `AuthSignupService.createUserAtomically`'s `sessionRepo.create` call does not
pass `pushToken`, unlike `AuthLoginService.loginStageTwo`'s call which does — confirm whether this is
intentional. If unintentional, the newly-signed-up device won't receive push notifications until its
first login/refresh restamps the session. Flag as a bug candidate (Open Question §7-Q3).

**SIGNUP-006 / Rate limits shared with login on the same phone**
Area: cross-cutting · Criticality: Medium · Traces to: §1.6
Steps: exhaust the 5-per-5-min `rl:otp:{phone}` bucket via `login/otp` calls, then attempt
`signup/otp` for the same phone.
Expected: 429 `RATE_LIMIT_EXCEEDED` on the signup call too — the counter is phone-scoped, not
purpose-scoped.

### 3.4 OTP mechanics (shared login/signup/step-up machinery)

**OTP-001 / Wrong code, attempts remaining reported and decrementing**
Area: rule · Criticality: High · Traces to: BR-4
Steps: submit a wrong code 3 times against the same `otp_request_id` (max 5).
Expected: each 422 `OTP_INVALID` response's `details.attemptsRemaining` counts down 4, 3, 2.

**OTP-002 / 5th wrong code returns OTP_MAX_ATTEMPTS, not OTP_INVALID (BR-4 boundary)**
Area: boundary/rule · Criticality: Critical
Steps: submit 5 wrong codes.
Expected: attempts 1–4 → `OTP_INVALID`; attempt 5 → 422 `OTP_MAX_ATTEMPTS` (`TOKEN_INVALID`); attempt
6 (even with the *correct* code) → still `OTP_MAX_ATTEMPTS` (the `WHERE attempts < maxAttempts` guard
now permanently excludes the row for this request id).

**OTP-003 / Reused (already-consumed) OTP rejected**
Area: state/rule · Criticality: Critical · Traces to: BR-3
Steps: verify successfully once, then replay the exact same `{phone, otp_code, otp_request_id}`.
Expected: 422 `OTP_ALREADY_CONSUMED` (`TOKEN_INVALID`) on the second call — regardless of whether the
first call was login or signup.

**OTP-004 / Concurrent verify calls for the same OTP request can't jointly exceed max attempts**
Area: concurrency · Criticality: High · Traces to: BR-4
Steps: fire 10 concurrent wrong-code verify calls against one `otp_request_id` (max 5).
Expected: at most 5 receive `OTP_INVALID`; the remainder receive `OTP_MAX_ATTEMPTS` — the atomic
`WHERE attempts < maxAttempts` update guarantees no more than 5 increments land, even under a race.

**OTP-005 / OTP is scoped per phone+purpose in Redis — a signup OTP request doesn't clobber a live login OTP for a different phone**
Area: rule · Criticality: Medium
Steps: request login OTP for phone A, request signup OTP for phone B, verify phone A's login OTP.
Expected: succeeds normally — keys are `otp:{phone}:{purpose}`, no cross-phone interference.

**OTP-006 / A second OTP request for the same phone+purpose invalidates the earlier code (Redis overwrite)**
Area: state/rule · Criticality: High
Steps: request login OTP (code C1), then (after the 60s resend cooldown, referencing `resend_of`)
request again (code C2) — do NOT verify with C1.
Expected: verifying with C1 against its own `otp_request_id` now fails `OTP_INVALID` (the Redis hash
under `otp:{phone}:login` was overwritten by C2's `SETEX`, so C1 no longer matches) even though C1's
Postgres row is still "active" (unexpired, unconsumed) — the DB row and the Redis code can disagree.
This is a real behavior to verify explicitly, not an assumption.

**OTP-007 / otp_lock blocks a second OTP request within 5 seconds, even a legitimate resend**
Area: boundary/negative · Criticality: Medium
Steps: call `login/otp` twice within 5 seconds for the same phone (second call includes a valid
`resend_of` referencing the first, and is otherwise ≥60s eligible in application terms — but the 5s
lock is a separate, tighter gate).
Expected: second call → 429 `RATE_LIMIT_EXCEEDED` "Request in progress", regardless of the 60s
cooldown logic — the 5s lock is checked first, unconditionally, before the `resend_of` cooldown
check even runs.

**OTP-008 / Resend cooldown enforced when resend_of references a real prior request**
Area: rule/boundary · Criticality: Medium · Traces to: `OTP_RESEND_COOLDOWN_SECONDS`
Steps: call `login/otp {resend_of}` 30 seconds after the referenced request (< 60s cooldown).
Expected: 429 `RATE_LIMIT_EXCEEDED` "Resend not yet available…".
Boundary: at exactly 60s elapsed, request succeeds (`elapsed < cooldown` — 60.0s is NOT less than 60,
so it should just barely pass; verify exact boundary behavior with a controlled clock).

**OTP-009 / resend_of pointing at a non-existent/garbage id skips the cooldown check entirely (gap)**
Area: negative/rule gap · Criticality: Medium
Steps: call `login/otp {resend_of: <random uuid not in otpRequests>}`.
Expected (per code): `otpRepo.findById(resendOf)` returns null → the `if (prev)` branch is skipped
entirely → **no cooldown is enforced** → a fresh OTP is issued immediately, same as if `resend_of`
were omitted. Confirm this is intended (a client can bypass its own cooldown by sending a bogus
`resend_of`) — flagged in Open Questions §7-Q4. The per-phone Redis rate limit (§1.6) still applies
as a backstop.

**OTP-010 / phone masking in the response never leaks more than the last 4 digits**
Area: UX/negative · Criticality: Low
Input: short phone edge case, e.g. a 5-digit `phone` value if the regex allowed it (it requires 7–15
digits per `PHONE_REGEX`, so this is more of a defensive-code check) and a normal 10+-digit phone.
Expected: `maskPhone` returns `****` only when `phone.length <= 4` (unreachable given the regex
minimum of 7 digits, so effectively dead code — confirm `otp_request` responses never surface this
field to the client at all; `OtpChallengeResponse` doesn't include `phoneMasked` today — check for
drift if it's added later).

**OTP-011 / step-up OTP purpose isolation from login/signup**
Area: rule · Criticality: High · Traces to: BR-2
Steps: request a step-up OTP, then try to verify it via `login/verify` with the same code+id.
Expected: 422 `OTP_EXPIRED` (purpose filter excludes it) — a step-up OTP can never be used to
complete an unrelated login.

### 3.5 Rate limiting & lockout — boundaries and negatives

**RL-001 / IP limit boundary — 100th request in 60s succeeds, 101st is blocked**
Area: boundary · Criticality: High · Traces to: `IP_MAX_ATTEMPTS`
Steps: from one IP, issue 100 `login/otp`+`login/verify` calls (mixed) inside a 60s window, then a
101st.
Expected: requests 1–100 pass the IP gate (may still fail other rules); the 101st → 429
`RATE_LIMIT_EXCEEDED` "Too many requests from this IP…", counted via the shared `rl:ip:{ip}` Redis
key across both endpoints.

**RL-002 / Per-phone OTP-bucket boundary — 5th action ok, 6th blocked, resets after 5 min**
Area: boundary · Criticality: High · Traces to: §1.6
Steps: perform 5 OTP-related actions (any mix of request/verify/purpose) for one phone inside 300s,
then a 6th; then wait for the window to roll and retry.
Expected: 6th → 429 `RATE_LIMIT_EXCEEDED` "Too many OTP requests for this phone…"; after the 5-minute
fixed window rolls over, the counter resets and a new action succeeds.

**RL-003 / Redis unavailable — rate limiting degrades to Postgres fixed-window fallback, never fails open**
Area: failure/recovery · Criticality: Critical · Traces to: `RateLimitService.enforce`
Steps: simulate Redis `EVAL` throwing (connection down) during `checkIpLimit`/`checkPhoneOtpLimit`.
Expected: service logs a warning and falls back to `RateLimitRepository.incrementFallbackWindow`
(atomic Postgres UPSERT-style counter keyed by the same window boundaries); limits are still
enforced (never "fail open" and allow unlimited attempts); once Redis recovers, subsequent calls use
the Redis path again with a possibly-reset window (Redis and Postgres windows are independent — note
as a minor consistency edge, not a security gap, since both degrade to *stricter*, never looser).

**RL-004 / otp_lock (5s) Redis unavailable — request unblocked (not a fail-closed path)**
Area: failure/negative gap · Criticality: Medium
Steps: simulate `redis.set(lockKey, ..., NX)` throwing.
Expected (per code): `OtpRequestService.requestOtp` does not catch this — an uncaught Redis error
here would propagate as a 500, not gracefully degrade. Confirm actual behavior in a real environment
(this differs from `RateLimitService`'s explicit try/catch fallback) — flag in Open Questions §7-Q5
if it indeed 500s instead of degrading.

### 3.6 Refresh — happy paths & device proof

**REFRESH-001 / Full rotation happy path with device signature**
Area: happy · Criticality: Critical · Traces to: BR-11, BR-12
Preconditions: logged-in session, refresh token in hand, device is NOT trusted (default).
Steps: 1) `POST refresh/challenge {refresh_token}` → `challenge_id`. 2) sign `challenge_id` with the
device's Ed25519 private key. 3) `POST refresh {refresh_token, challenge_id, device_signature}`.
Expected: 200 `RefreshResponse` with a NEW `access_token` + NEW `refresh_token`; old refresh token
row `usedAt` set; new row `parentId` = old id, same `familyId`; session `currentJti` updated to the
new token's `jti`; old JTI blacklisted (best-effort); `snapshot`/`snapshot_signature` present only if
`snapshot_version` in the request is stale or omitted (else null, `snapshot_changed:false` equivalent
via `RefreshResponse.snapshot=null`).

**REFRESH-002 / Passing snapshot_version equal to current returns null snapshot (no payload needed)**
Area: rule · Criticality: Medium
Steps: refresh with `snapshot_version` equal to the user's current `permissionsVersion`.
Expected: 200 with `snapshot: null, snapshot_signature: null`, `snapshot_version` still returned as
the authoritative current version.

**REFRESH-003 / Old refresh token stops working immediately after rotation**
Area: state · Criticality: Critical · Traces to: BR-11
Steps: rotate once (REFRESH-001), then immediately call `refresh/challenge` with the OLD refresh
token again (>30s after `usedAt` to be past the race-grace, or use the fact `refresh/challenge`'s own
window is 600s so this call itself still succeeds up to 600s — see REFRESH-004), then attempt a real
`refresh` rotate with the old token.
Expected: `refresh/challenge` on a used-but-within-600s token still issues a challenge (recovery
path); but `POST refresh` with the old token, a NEW challenge, and a valid signature → 401
`REFRESH_TOKEN_REUSE` once past the 30s grace, AND the entire token family (including the new,
unused successor) is revoked — confirm the successor token issued in REFRESH-001 is now also dead
(next legitimate refresh attempt with it fails `REFRESH_TOKEN_REVOKED`), forcing the user to
fully re-login. This is the core theft-response guarantee — test it explicitly end-to-end.

**REFRESH-004 / Device-proof required — missing challenge/signature rejected**
Area: rule · Criticality: Critical · Traces to: BR-12
Steps: `POST refresh {refresh_token}` with no `challenge_id`/`device_signature`.
Expected: 401 `DEVICE_PROOF_REQUIRED`.

**REFRESH-005 / Challenge minted for device A cannot prove device B**
Area: negative/security · Criticality: Critical
Steps: obtain a valid challenge for device A's refresh token, but submit it (with any signature) on
device B's refresh/rotate call.
Expected: `consumeChallenge` returns device A's id; compared against the session's actual
`deviceFk` (device B) → mismatch → 401 `DEVICE_SIGNATURE_INVALID` (challenge is consumed/burned
regardless of the mismatch — a client retry needs a fresh challenge).

**REFRESH-006 / Forged/invalid device signature rejected**
Area: negative/security · Criticality: Critical
Steps: submit a syntactically-valid but cryptographically-wrong `device_signature`.
Expected: 401 `DEVICE_SIGNATURE_INVALID`; challenge already consumed (GETDEL), so retry needs a new
challenge from `refresh/challenge`.

**REFRESH-007 / Challenge is single-use (GETDEL) — replaying the same challenge_id fails**
Area: state · Criticality: High
Steps: use a challenge+signature successfully once (or even unsuccessfully once), then resubmit the
same `challenge_id` on a second `refresh` call.
Expected: 401 `CHALLENGE_NOT_FOUND` — `consumeChallenge` already deleted the Redis key on first use.

**REFRESH-008 / Challenge expires after 5 minutes**
Area: boundary/time · Criticality: Medium · Traces to: `DEVICE_CHALLENGE_TTL_SECONDS`
Steps: issue a challenge, wait >300s, attempt to consume it.
Expected: 401 `CHALLENGE_NOT_FOUND` (Redis key expired).

**REFRESH-009 / Revoked/expired refresh token or session rejected at both endpoints**
Area: state · Criticality: Critical
Cases (each a sub-case): (a) session revoked (via logout elsewhere) → `refresh/challenge` → 401
`SESSION_REVOKED`; `refresh` → same. (b) session `expiresAt` passed (30-day boundary) → `SESSION_EXPIRED`
on both. (c) refresh token itself revoked (family revoke) → `REFRESH_TOKEN_REVOKED`. (d) refresh
token `expiresAt` passed → `REFRESH_TOKEN_EXPIRED`.

**REFRESH-010 / Refresh rejected for deleted or non-active user**
Area: rule · Criticality: Critical
Preconditions: user `deletedAt` set, OR `status` is anything other than `'active'` (including
`'locked'` or `'suspended'`).
Expected: `deletedAt` → 401 `USER_NOT_FOUND`; any non-`'active'` status → 401 `USER_SUSPENDED` — note
this is **stricter** than login (which only special-cases `isBlocked`/`suspended`): a `'locked'`
user (mid account-lockout) is also blocked from refreshing, unlike login which only gates on the
`accountLockedUntil` timestamp. Confirm this asymmetry is intended (Open Questions §7-Q6).

**REFRESH-011 / Bound device no longer exists**
Area: negative · Criticality: Medium
Preconditions: the device row backing the session was hard-deleted (if such a path exists) or the
`deviceFk` is otherwise dangling.
Expected: 401 `DEVICE_NOT_FOUND`.

**REFRESH-012 / Trusted device skips proof requirement**
Area: rule · Criticality: Medium · Traces to: BR-12
Preconditions: `devices.isTrusted = true` (requires a manual DB flip or a future trust-granting
endpoint — none exists in this module today).
Steps: call `refresh` with no `challenge_id`/`device_signature`.
Expected: rotation succeeds without device proof. Note: since no code path currently sets
`is_trusted`, this case can only be exercised via direct DB manipulation in test — call out as a
seam, not a reachable production flow yet.

### 3.7 Refresh — concurrency & idempotency

**REFRESH-020 / Client retries the identical refresh request (e.g., after a network timeout) gets the identical cached pair**
Area: concurrency · Criticality: Critical · Traces to: idempotency `claim`/`complete`
Steps: call `refresh` with a given `{refresh_token, challenge_id, device_signature}`; the response is
lost client-side (simulate a dropped response); the client retries with the exact same body within
600s.
Expected: second call is served from the idempotency cache (`role:'cached'`) — identical
`access_token`/`refresh_token` returned, no second rotation, no family revocation — **provided** the
same `challenge_id` is still valid; if the client got a NEW challenge for the retry, device proof is
re-verified against the cached result's session (REFRESH-021).

**REFRESH-021 / Cached-path retry with a stale/already-consumed challenge fails device proof**
Area: concurrency/negative · Criticality: High
Steps: perform REFRESH-020's first call (consumes challenge C1); retry reusing C1 (already
GETDEL'd).
Expected: `verifyDeviceProofForCached` → `assertDeviceProof` → `consumeChallenge(C1)` → 401
`CHALLENGE_NOT_FOUND` even though the underlying rotation already succeeded — the client must fetch
a fresh challenge for every retry attempt, cached or not.

**REFRESH-022 / Two genuinely concurrent rotations of the same token — one wins, one gets a retryable signal**
Area: concurrency · Criticality: Critical · Traces to: idempotency `leader`/`timed_out`, `REUSE_GRACE_MS`
Steps: fire two `refresh` calls with the identical refresh token simultaneously (idempotency claim
not yet resolved for either).
Expected: one becomes `role:'leader'` and performs the rotation; the other, if it arrives while the
leader is still mid-transaction, either (a) polls and receives the leader's cached `done` result once
available (<3s), or (b) if the leader is still pending past 3s, gets 503
`REFRESH_IN_PROGRESS_RETRY` — **never** a false `REFRESH_TOKEN_REUSE`/family revocation, which was
the specific bug this idempotency layer was built to close (see code comments on `ClaimResult`).

**REFRESH-023 / CAS loser within reuse-grace gets a retry signal, not reuse-detection**
Area: concurrency · Criticality: Critical · Traces to: `REUSE_GRACE_MS` = 30s
Steps: simulate the idempotency layer being unavailable (so both concurrent calls become
`'leader'`), both reach `commitRotation`'s `markUsed` CAS within the same transaction window.
Expected: the winner rotates normally; the loser's `markUsed` fails, `findUsedAt` shows a timestamp
<30s old → `lost_recent` → 503 `REFRESH_IN_PROGRESS_RETRY`. The family is NOT revoked and the
winner's newly-issued successor token remains valid.

**REFRESH-024 / Replay outside the reuse-grace window revokes the family (genuine theft signal)**
Area: concurrency/security · Criticality: Critical
Steps: token is used (rotated) at T0; at T0+60s (past the 30s grace), the same old token is
presented again for rotation.
Expected: `assertTokenUsable` sees `usedAt` 60s old → NOT within grace → `revokeFamily` +
401 `REFRESH_TOKEN_REUSE`; the current (legitimate) token in that family is now also revoked.

**REFRESH-025 / Idempotency record fails to decrypt (secret rotated / tampered) degrades to retryable, not a second rotation**
Area: failure/security · Criticality: Medium
Preconditions: `JWT_REFRESH_SECRET` rotated between `complete()` and a retry's `readRecord()` (the
cache-encryption key derives from it).
Expected: `decryptJson` throws → `readRecord` returns `{role:'timed_out'}` → caller gets 503
`REFRESH_IN_PROGRESS_RETRY`, never a raw decrypt error and never a duplicate live rotation attempt.

### 3.8 Logout & session management

**LOGOUT-001 / Logout blacklists the current token and revokes the session atomically**
Area: happy/rule · Criticality: Critical · Traces to: BR-15 (single-session variant)
Steps: authenticated `POST logout`.
Expected: 204; session `revokedAt`/`revokedReason='user_logout'` set; refresh tokens for that session
revoked; `currentJti` blacklisted (durable DB row + Redis + LRU); device store-slots released
(BR-14); `LOGOUT` audit row; session cache tombstoned. A subsequent request with the now-stale access
token → `MobileJwtGuard` → 401 `TOKEN_REVOKED` (blacklist hit, checked before session lookup) or
`SESSION_REVOKED` depending on which check a concurrent request hits first — both are acceptable
terminal states; verify neither returns a stale "still valid".

**LOGOUT-002 / Logout is only reachable once per token (guard blocks replays)**
Area: state · Criticality: Medium
Steps: call `logout` twice with the same (now-revoked) access token.
Expected: first call 204; second call never reaches the controller — `MobileJwtGuard` rejects with
`TOKEN_REVOKED` before the handler runs, so `AuthLogoutService.logout()` is never invoked twice for
the same session (idempotent by construction, not by explicit dedup logic).

**LOGOUT-003 / Logout-all revokes every session across every device for the user**
Area: happy/rule · Criticality: Critical · Traces to: BR-15
Preconditions: 3 active sessions across 3 devices.
Steps: `POST logout/all` from device 1.
Expected: 204; all 3 sessions revoked (`reason='user_logout_all'`), all 3 refresh-token sets revoked,
all 3 JTIs blacklisted in one batched insert, `LOGOUT_ALL` audit row with count=3, all 3 session
caches invalidated. Devices 2 and 3's next authenticated call fails `SESSION_REVOKED`/`TOKEN_REVOKED`
immediately (not after a 30s cache-staleness window — tombstone fencing prevents resurrection, per
`SessionCacheInvalidatorService`).

**LOGOUT-004 / Logout-all with zero active sessions is a safe no-op**
Area: edge/boundary · Criticality: Low
Preconditions: user has no active sessions (all already revoked/expired).
Expected: 204; `sessions.length === 0`; `addManyToBlacklist([])`/`revokeByManySessions([])` both
no-op immediately (explicit length-0 guards); audit row still written with count=0.

**LOGOUT-005 / User can list only their own sessions, paginated**
Area: permission/happy · Criticality: High
Steps: `GET /sessions` as user A with 3 sessions; as user B with 1 session.
Expected: each sees only their own; response is a `PaginatedResponse<SessionResponse>`; the session
matching the caller's `deviceSessionId` has `is_current:true`, all others `false`; `X-Permissions-
Version` header present (via `SnapshotRefreshInterceptor`) plus `snapshot`/`snapshot_changed` fields
merged into the payload.

**LOGOUT-006 / sessions limit boundary — default 20, max 100, invalid falls back to default**
Area: boundary · Criticality: Medium · Traces to: `clampLimit`
Steps: call `GET /sessions` with `?limit=` omitted, `limit=0`, `limit=-5`, `limit=500`, `limit=abc`.
Expected: omitted/0/-5/`abc` → default 20; `500` → clamped to 100; never a validation error for these
malformed values (lenient policy, by design).

**LOGOUT-007 / User cannot revoke another user's session (ownership enforced)**
Area: permission/negative · Criticality: Critical
Steps: user A calls `DELETE /sessions/:id` with user B's session id.
Expected: 404 `NOT_FOUND` "Session not found" — `findActiveByIdForUser` scopes the lookup to
`(id, userFk)`, so cross-user ids are indistinguishable from nonexistent ones (no information leak
about whether the id belongs to someone else).

**LOGOUT-008 / Revoking a session that's already revoked returns 404, not a duplicate revoke**
Area: state/negative · Criticality: Medium
Steps: revoke a session, then attempt to revoke the same id again.
Expected: 404 `NOT_FOUND` (the lookup filters `isNull(revokedAt)`).

**LOGOUT-009 / Revoking your OWN current session via DELETE /sessions/:id does NOT release device store-slots (BR-14 asymmetry)**
Area: rule/negative gap · Criticality: High · Traces to: BR-14
Steps: as the currently-authenticated device, call `DELETE /sessions/:id` with your OWN
`deviceSessionId` (instead of calling `POST logout`).
Expected: session is revoked and its JWT blacklisted (same as logout), BUT
`deviceAccess.revokeAllSlotsForDevice` is never called — verify whether this device's store slot
remains occupied until the 30-day auto-expiry cron, unlike a proper `logout` which releases it
immediately. Confirm with product whether self-revoke-via-list should also release slots (Open
Questions §7-Q7).

**LOGOUT-010 / Revoke of a stolen device from a trusted device is effective immediately**
Area: security/happy · Criticality: Critical
Steps: device X is suspected stolen; from device Y (trusted, logged in), call
`DELETE /sessions/:deviceX_session_id`.
Expected: device X's session revoked + JTI blacklisted before its 30s cache TTL or 15-min JWT
expiry would otherwise have let it through — confirm the very next authenticated call FROM device X
fails immediately (tombstone fencing prevents the cache from serving a stale "still valid" row).

### 3.9 Step-up re-authentication

**STEPUP-001 / OTP step-up happy path**
Area: happy · Criticality: High
Steps: `POST step-up/otp` (authenticated; body's `phone`, if any, is ignored) → OTP sent to the
caller's OWN registered phone; `POST step-up/verify {method:'otp_sms', credential:<code>,
otp_request_id}`.
Expected: 200 `{ok:true, method:'otp_sms', completed_at, valid_until}`; `valid_until` = completed_at
+ 300s (default) unless a valid `intended_window_seconds` (1–3600) was supplied; session's
`lastStepUpAt`/`lastStepUpMethod` updated; session cache invalidated so the freshly-stepped-up state
is visible immediately to the next guarded call.

**STEPUP-002 / Biometric step-up happy path**
Area: happy · Criticality: High
Steps: `POST step-up/challenge` → `challenge_id`; sign with device key; `POST step-up/verify
{method:'biometric', credential:<signature>, challenge_id}`.
Expected: 200; challenge consumed (single-use); device signature verified against the DB-resolved
public key (never a client-supplied key).

**STEPUP-003 / A client-supplied phone in the step-up-OTP request body is ignored (BR-17)**
Area: rule/security · Criticality: Critical · Traces to: BR-17
Input: `POST step-up/otp {phone: "+911111111111"}` (some other, arbitrary number) while authenticated
as a user whose real registered phone is different.
Expected: the OTP is sent to the AUTHENTICATED USER'S OWN phone (from `userRepo.findById`), never to
the phone in the body — verify no SMS is sent to the arbitrary number and no OTP row references it.
This prevents an authenticated attacker from SMS-bombing/enumerating arbitrary numbers via this
endpoint.

**STEPUP-004 / Zod schema requires otp_request_id for otp_sms and challenge_id for biometric**
Area: negative/boundary · Criticality: Medium
Input: `{method:'otp_sms'}` (no `otp_request_id`); `{method:'biometric'}` (no `challenge_id`).
Expected: both → 422 `VALIDATION_FAILED` via the `superRefine` custom checks, before reaching the
service.

**STEPUP-005 / 5 failed step-up attempts in 5 minutes locks the session (BR-16 boundary)**
Area: boundary/rule · Criticality: Critical · Traces to: BR-16
Steps: submit 5 failing step-up verifications (wrong OTP / bad signature) within `stepUpRateWindowSeconds`(300s).
Expected: attempts 1–4 return the underlying error (`OTP_INVALID`/`DEVICE_SIGNATURE_INVALID`); the
5th ALSO returns the underlying error but additionally sets `stepUpLockedUntil = now+300s` on the
session; the 6th attempt (even with a correct credential) → 429 `STEP_UP_LOCKED` before any
credential check runs.

**STEPUP-006 / Step-up lock is per-session, not per-user**
Area: rule/permission · Criticality: Medium · Traces to: BR-16
Steps: lock session A (device 1) via STEPUP-005; attempt step-up on session B (device 2, same user).
Expected: session B is unaffected — `stepUpLockedUntil` lives on `deviceSessions`, keyed by
`deviceSessionId`, not the user.

**STEPUP-007 / Step-up on a revoked/nonexistent session**
Area: negative/state · Criticality: Medium
Preconditions: the session referenced by the caller's principal was revoked concurrently (e.g. via
`logout/all` from another device mid-flow).
Expected: `sessionRepo.findById` still returns the row (it's not deleted, just `revokedAt` set) — but
per code, `StepUpService.verify` only checks `if (!session)`, not `session.revokedAt`; confirm
whether a revoked session can still complete a step-up (likely unreachable in practice because
`MobileJwtGuard` itself already rejects revoked sessions before the controller runs, but worth an
explicit test to confirm the guard, not the service, is what actually prevents this).

**STEPUP-008 / intended_window_seconds boundary — 1s minimum, 3600s maximum, out-of-range rejected**
Area: boundary · Criticality: Low
Input: `intended_window_seconds: 0`, `1`, `3600`, `3601`.
Expected: `0` and `3601` → 422 validation error; `1` and `3600` → accepted, `valid_until` computed
accordingly.

### 3.10 MobileJwtGuard

**JWT-001 / Missing Authorization header**
Area: negative · Criticality: Critical
Input: request with no `Authorization` header.
Expected: 401 `MISSING_TOKEN`.

**JWT-002 / Malformed / non-Bearer Authorization header**
Area: negative · Criticality: Medium
Input: `Authorization: Basic abcd` or `Authorization: garbage`.
Expected: 401 `MISSING_TOKEN` (only `Bearer ` prefix is accepted).

**JWT-003 / Expired access token**
Area: boundary/state · Criticality: Critical
Preconditions: token minted >900s ago.
Expected: 401 `TOKEN_INVALID` ("Invalid or expired access token" — `jose`'s expiry and signature
failures are collapsed into the same code by design).

**JWT-004 / Tampered / bad-signature token**
Area: negative/security · Criticality: Critical
Input: a token with a flipped byte in the signature, or signed with a different secret.
Expected: 401 `TOKEN_INVALID`.

**JWT-005 / Wrong token type (a refresh-shaped or other-typed token used as access)**
Area: negative · Criticality: High
Expected: 401 `INVALID_TOKEN_TYPE` (only after signature verification succeeds and `type !== 'access'`).

**JWT-006 / Blacklisted JTI rejected even if the JWT itself is still cryptographically valid and unexpired**
Area: state/security · Criticality: Critical
Preconditions: token's `jti` blacklisted (via logout/rotation) but `exp` still in the future.
Expected: 401 `TOKEN_REVOKED` — checked before session/device/user lookups, so this is the first line
of defense for immediate revocation.

**JWT-007 / Session not found / revoked / expired**
Area: state · Criticality: Critical
Three sub-cases: session id doesn't exist → `SESSION_NOT_FOUND`; `revokedAt` set →
`SESSION_REVOKED`; `expiresAt` passed → `SESSION_EXPIRED`.

**JWT-008 / Superseded token (currentJti mismatch) — "signed in on another device" (BR-13)**
Area: state/security · Criticality: Critical · Traces to: BR-13
Steps: rotate the refresh token (issuing a new access token/jti), then present the OLD (pre-rotation)
access token to any guarded endpoint before it naturally expires.
Expected: 401 with `errorCode: SESSION_REPLACED`, message "You've been signed in on another device.
Please log in again." — this fires even if the rotation's best-effort blacklist write for the old JTI
silently failed, because `currentJti` on the session row is the authoritative fallback.

**JWT-009 / Device blocked mid-session**
Area: state/permission · Criticality: Critical
Preconditions: `devices.isBlocked = true` (set by an admin action elsewhere) while a session for that
device is otherwise still valid.
Expected: 401 `DEVICE_BLOCKED` — enforced on every request via the (≤30s-cached) `PrincipalCacheService`
projection; within that cache window a request could theoretically still pass on a stale hit — note
the comment in code says device-block additionally revokes sessions in the SAME transaction as the
block, so `SESSION_REVOKED` would actually catch it sooner in practice; test both the direct-block
path and a simulated cache-staleness window to confirm the guaranteed bound.

**JWT-010 / User soft-deleted / blocked / suspended / locked mid-session**
Area: state/permission · Criticality: Critical
Four sub-cases against a live session: `deletedAt` set → `USER_NOT_FOUND`; `isBlocked=true` →
`USER_BLOCKED`; `status='suspended'` → `USER_SUSPENDED`; `status='locked'` → **also** `USER_SUSPENDED`
(same code as suspended — the guard doesn't distinguish the two `status` values, only login does).

**JWT-011 / accountLockedUntil in the future blocks an otherwise-valid session**
Area: state · Criticality: High
Preconditions: `accountLockedUntil` set to a future time (e.g. an admin manually re-locks, or a
lockout was applied) while the caller still holds a pre-lock, unexpired access token.
Expected: 401 `ACCOUNT_LOCKED` — checked after the `suspended`/`locked` status check, so if `status`
was also flipped to `'locked'` the caller sees `USER_SUSPENDED` first (status check runs before the
timestamp check); construct the case where ONLY `accountLockedUntil` is set (status still `'active'`)
to actually observe `ACCOUNT_LOCKED` distinctly.

**JWT-012 / phoneVerified=false blocks the session**
Area: state · Criticality: Medium
Preconditions: (largely unreachable via normal OTP flows, since both login and signup stamp
`phoneVerified:true` — construct via direct DB manipulation, or a hypothetical future non-OTP signup
path).
Expected: 401 `PHONE_NOT_VERIFIED`.

**JWT-013 / Missing replay-protection headers rejected on every guarded route (BR-18)**
Area: rule/security · Criticality: Critical · Traces to: BR-18
Steps: call any JWT-guarded endpoint (`logout`, `sessions`, `step-up/*`) with a valid access token but
no `x-timestamp`/`x-nonce` headers.
Expected: 401 `REPLAY_DETECTED` "Missing replay-protection headers" — this applies broadly, not just
to refresh; confirm test automation always attaches these headers for ALL guarded calls or every
other guard test above will actually fail on this check first.

**JWT-014 / Stale timestamp (outside ±30s drift) rejected**
Area: boundary/security · Criticality: High · Traces to: `TIMESTAMP_DRIFT_MS`
Input: `x-timestamp` 45s in the past (or future).
Expected: 401 `REPLAY_DETECTED` "Request timestamp outside the allowed window". Boundary: exactly
30,000ms difference — `Math.abs(...) > 30_000` — so exactly 30s is still accepted, 30.001s is not;
worth an exact-boundary test.

**JWT-015 / Reused nonce rejected (replay)**
Area: security · Criticality: Critical
Steps: call a guarded endpoint successfully with `x-nonce: N1`; immediately replay the identical
request (same token, same timestamp within drift, same `N1`).
Expected: second call → 401 `REPLAY_DETECTED` "Request nonce has already been used" (`SET NX`
failed); nonce dedup window is 600s, keyed per-device (`nonce:{deviceId}:{nonce}`), so the same nonce
value reused by a DIFFERENT device is not blocked by this check (device-scoped, not global) — verify
that's intended.

**JWT-016 / Session cache degrades to DB on Redis error, never on a genuine miss (fail-safe distinction)**
Area: failure/recovery · Criticality: High
Steps: (a) simulate a Redis read error during `loadSession` → confirm fallback to DB read (never
treated as "no session"/log-everyone-out). (b) simulate a genuine cache miss (key expired, TTL 30s)
→ confirm fallback to DB read too, then a best-effort tombstone-respecting cache refill.
Expected: both degrade to DB; only an actual DB miss (row doesn't exist) yields `SESSION_NOT_FOUND`.

**JWT-017 / Corrupt/mismatched cached session payload is rejected, not blindly trusted**
Area: failure/security · Criticality: Medium
Preconditions: a hand-crafted or schema-drifted JSON blob under `session:{id}` in Redis.
Expected: `DeviceSessionSchema` (Zod) fails to parse → `readTypedCache` returns null → falls through
to DB, never deserializes a malformed/attacker-influenced cache entry into a trusted session object.

### 3.11 SubscriptionStatusGuard (mid-session gating)

**SUB-001 / Reads always pass regardless of subscription status**
Area: rule · Criticality: High · Traces to: BR-19
Steps: with an account whose subscription `status='expired'`, call any GET/HEAD/OPTIONS route this
guard sits on.
Expected: 200 — guard returns `true` immediately for read methods, headers (`X-Subscription-Version`,
optional `X-Subscription-Warning`) still stamped.

**SUB-002 / Suspended (admin/abuse) blocks writes regardless of access window**
Area: rule · Criticality: Critical
Preconditions: `status='paused'`, `accessValidUntil` far in the future (window otherwise open).
Expected: a write (POST/PUT/PATCH/DELETE) → 403 `SUBSCRIPTION_SUSPENDED` — status alone is
determinative, independent of the window.

**SUB-003 / Expired status blocks writes with 402, not 403**
Area: rule/boundary · Criticality: Critical
Preconditions: `status='expired'`.
Expected: 402 `SUBSCRIPTION_PAYMENT_REQUIRED`.

**SUB-004 / Access window closed but status not yet flipped (cron-lag) still blocks writes (soft block)**
Area: rule/time · Criticality: High
Preconditions: `status='active'` or `'trialing'`, but `accessValidUntil` is in the past.
Expected: 402 `SUBSCRIPTION_PAYMENT_REQUIRED` — the window check is independent of and in addition to
the `status` enum checks.

**SUB-005 / accessValidUntil exactly "now" — boundary**
Area: boundary/time · Criticality: Medium
Preconditions: `accessValidUntil` = current instant.
Expected: `new Date(accessValidUntil) < new Date()` — a value equal to "now" at check time (already
in the past by the time the comparison runs, due to execution latency) is effectively always
evaluated as expired in this exact-tie scenario; note as a timing-sensitive boundary rather than a
strict off-by-one, and test with a window set a few hundred ms in the future vs. past to establish
the real cutover.

**SUB-006 / Pending reconciliation blocks all writes account-wide until resolved**
Area: rule/state · Criticality: High
Preconditions: `reconciliationStatus='pending'` (e.g. after a plan downgrade left stores/devices over
the new limit), status/window otherwise fine.
Expected: 403 `SUBSCRIPTION_RECONCILIATION_REQUIRED` on writes; reads still pass.

**SUB-007 / Store-level lock blocks writes independent of the account-wide reconciliation gate**
Area: rule/state · Criticality: High
Preconditions: `reconciliationStatus` NOT pending (resolved), but the specific store's
`resolvedStoreContext.isLocked = true` (a downgrade-reconciliation decision to keep other stores).
Expected: 403 `STORE_LOCKED` on writes to that store.

**SUB-008 / @AllowExpiredSubscription()-decorated handler bypasses the write gate**
Area: rule · Criticality: Medium
Preconditions: `status='expired'`, handler decorated `@AllowExpiredSubscription()`.
Expected: write succeeds (200/201/etc.), guard returns `true` before reaching any status check.

**SUB-009 / Guard fails safe when no tenant context is resolved**
Area: negative/failure · Criticality: High
Preconditions: guard applied to a route where the tenant/store guard didn't run first (misconfigured
pipeline) — `req.context` undefined.
Expected: 403 `STORE_CONTEXT_MISSING`, not a crash or a silent pass.

**SUB-010 / Trialing / past_due emit a warning header but do NOT block writes**
Area: UX/rule · Criticality: Medium
Preconditions: `status='trialing'` with a future `accessValidUntil`, or `status='past_due'` within
its grace window.
Expected: writes succeed; `X-Subscription-Warning` header present:
`trialing:ends_at_<iso>` or `past_due:grace_until_<iso>` respectively; no warning header once neither
condition applies.

**SUB-011 / Guard-thrown 402/403 responses still carry the freshness headers**
Area: cross-cutting/UX · Criticality: Medium
Steps: trigger SUB-003 (402) and inspect response headers.
Expected: `X-Subscription-Version` and (if applicable) `X-Subscription-Warning` are present on the
error response too — stamped explicitly inside the guard before throwing, since NestJS skips
interceptors on a guard rejection.

**SUB-012 / Cache-aside subscription snapshot degrades to DB on Redis miss/corruption**
Area: failure/recovery · Criticality: Medium
Steps: (a) version pointer missing → DB read + cache repopulate. (b) version pointer present but the
versioned snapshot key missing/corrupt → same fallback. (c) Redis entirely unreachable → caught,
falls through to DB, guard never fails purely due to cache unavailability.
Expected: correct authorization decision in all three cases, just slower (extra DB round trip).

**SUB-013 / Auth endpoints themselves are never subscription-gated**
Area: cross-cutting/rule · Criticality: High · Traces to: BR-19
Steps: with `status='expired'`/`paused'`, call `login/verify`, `logout`, `refresh`, `sessions`.
Expected: none of these routes carry `SubscriptionStatusGuard` (no store context to resolve for
account-less/tenant-less auth flows) — all behave exactly per their own JWT-guard rules regardless of
subscription state; a cashier must always be able to log out / rotate tokens / manage sessions even
with a fully lapsed account.

---

## 4. Edge-case scenarios (the ones teams miss — §5 checklist applied)

**EDGE-001 / Empty/whitespace phone**
Input: `phone: ""` or `phone: "   "`.
Expected: 422 `VALIDATION_FAILED` (`PHONE_REGEX` requires 7–15 digits, optional leading `+`) before
any service logic runs.

**EDGE-002 / Phone with leading/trailing whitespace or non-canonical formatting**
Input: `phone: " +919876543210 "`, `phone: "919876543210 "`.
Expected: regex match is exact (`^\+?[1-9]\d{6,14}$`, no `trim()` applied anywhere in the schema) —
confirm whether whitespace is rejected outright (422) rather than silently trimmed; if the mobile
client doesn't trim before sending, this is a real UX edge to verify.

**EDGE-003 / OTP code with leading zero, exactly 6 digits, boundary of randomInt(100000, 999999)**
Input: a code like `012345` is impossible (`randomInt(100_000, 999_999)` never produces <100000), but
client-submitted `otp_code` could still be any 6-character string per the Zod schema
(`z.string().length(6)`, no digit-only constraint!).
Expected: submitting a non-numeric 6-character string, e.g. `"abcdef"`, passes DTO validation (length
6) and reaches `verifyOtp`, which compares its hash against the stored code's hash — always mismatches
→ `OTP_INVALID`, consuming an attempt. Confirm the DTO's lack of a digit-only regex isn't otherwise
exploitable (it isn't, since the hash comparison is what actually gates correctness) but flag as a
looseness worth tightening (Open Questions §7-Q8).

**EDGE-004 / First-ever login for a brand-new account created via signup (no lastAccountMode yet)**
Steps: signup, then immediately call whatever "bootstrap"/session flow reads `last_account_mode`.
Expected: `last_account_mode: null` on the signup response; the client is expected to prompt the user
to choose business/personal (mobile-03 §3c/3d) and call `updateAccountMode`.

**EDGE-005 / Very long name / unicode / emoji in signup**
Input: `name: "🧑‍🍳 Örnek İşletme 名前"` (mixed unicode/emoji, well under 100 chars).
Expected: accepted — no charset restriction beyond length in `SignupVerifyDtoSchema`; verify it's
stored and echoed back correctly (no mangling) — not directly observable in the auth response, but
worth a downstream check.

**EDGE-006 / Duplicate/rapid double-submission of login/verify (double-tap)**
Steps: fire two identical `login/verify` calls back-to-back with the same correct OTP code before
either completes.
Expected: only one can consume the OTP (`markConsumed`/attempt-increment are atomic); the second,
racing call is likely to either (a) lose the OTP-consumption race and see `OTP_ALREADY_CONSUMED`, or
(b) if truly simultaneous at the DB row level, be serialized by the `WHERE attempts < maxAttempts`
update — verify no double session/device/refresh-token pair is ever created for a single logical
tap (i.e., no double-login side effect), even though there's no explicit request-level idempotency
key on login (unlike refresh, which has one).

**EDGE-007 / Out-of-order arrival — refresh/challenge called after the refresh token was already rotated by another request**
Steps: rotate a token successfully (via a separate in-flight request the tester doesn't wait on),
then call `refresh/challenge` with the pre-rotation token.
Expected: within the 600s recovery window, a challenge is still issued (by design, for the crashed-
client-recovery case) even though the token is technically "used" — this is intentionally permissive
for the specific recovery flow; confirm it does NOT allow issuing endless legitimate-looking
challenges for a token an attacker merely observed in transit (device-signature proof is still the
real gate at the actual `refresh` call).

**EDGE-008 / Offline device queues a refresh, comes back online after its refresh token has expired (30 days)**
Steps: simulate a device offline for >30 days, then attempt to refresh on reconnect.
Expected: 401 `REFRESH_TOKEN_EXPIRED` (or `SESSION_EXPIRED` if the session's own 30-day clock also
lapsed) — the mobile client must detect this and route the user back to full login (OTP), not retry
refresh indefinitely.

**EDGE-009 / Clock skew — device's signed challenge timestamp arrives with a skewed system clock**
Steps: device's local clock is 45s ahead/behind server time when it stamps `x-timestamp` for a
guarded call (not the refresh endpoints, which are unauthenticated and don't carry these headers —
this applies to `logout`/`sessions`/`step-up/*`).
Expected: 401 `REPLAY_DETECTED` "Request timestamp outside the allowed window" if skew exceeds 30s —
this is a realistic field issue (cheap Android devices with drifted clocks) worth flagging to product
as a UX risk, not just a security edge (Open Questions §7-Q9).

**EDGE-010 / Timezone-agnostic expiries — all TTLs are UTC-instant based, no calendar-day rollover**
Confirm: `accountLockedUntil`, OTP `expiresAt`, refresh/session `expiresAt`, step-up `validUntil` are
all absolute `Date` instants derived from `Date.now()`, never calendar-day/timezone-relative — no
"resets at midnight" edge exists in this module; explicitly verify no case wrongly assumes a
midnight-local-time reset.

**EDGE-011 / App killed mid-refresh — client never receives the new token pair**
Steps: client sends `refresh`, server completes rotation and commits, but the process is killed
before the response is read; client relaunches and retries the SAME (now-used) old refresh token.
Expected: covered by REFRESH-020's cached-idempotency path within 600s of the original `usedAt` — the
relaunched client gets the identical new pair back (given it still has a way to prove device
possession, i.e. a fresh challenge/signature for the cached-path proof) rather than being locked out
or triggering false reuse-detection.

**EDGE-012 / Permission/subscription lapses mid-session while the user is mid-checkout on another screen**
Steps: a cashier is authenticated (valid session), subscription flips from `active` to `expired`
mid-shift (e.g. billing cron runs), cashier attempts a mutating store action (e.g. create an order —
out of this module's direct scope, but gated by the same `SubscriptionStatusGuard`).
Expected: the mutating call is blocked (402) starting from the moment the guard's cache picks up the
new status (bounded by the subscription cache TTL, not this module's session TTLs) — but the cashier
can still `logout`, view sessions, and refresh tokens throughout, since those routes aren't
subscription-gated (BR-19/SUB-013).

**EDGE-013 / Role/permission-affecting change mid-session is reflected via the snapshot, not the JWT**
Steps: a manager's RBAC role is changed by an owner mid-session (out of this module, but
`permissionsVersion` bumps as a result); the mobile client keeps using its still-valid 15-min access
token.
Expected: the JWT's `pv` claim (permissions version at issue time) becomes stale, but authorization
decisions for RBAC-guarded actions elsewhere are expected to consult the live snapshot/DB, not the
JWT's embedded `pv`; the NEXT refresh or `/sessions` call surfaces the updated `permissionsVersion`
via `X-Permissions-Version`/snapshot diff (`snapshot_changed:true`) — confirm the 15-minute worst-case
staleness window for a stale-permission JWT is an accepted product tradeoff (Open Questions §7-Q10).

**EDGE-014 / Abandonment — user requests OTP then closes the app before verifying**
Steps: request `login/otp`, never call `verify`.
Expected: no side effects beyond the OTP row + Redis code expiring naturally after 300s; no lockout,
no audit noise beyond the initial request's `recordAttempt(success:false)` audit-trail insert
(informational only, not an enforcement signal by itself).

**EDGE-015 / Interruption — step-up OTP requested, then an incoming call/notification delays verify past expiry**
Steps: request step-up OTP, wait >300s (simulating a real-world interruption), then verify.
Expected: 422 `OTP_EXPIRED`; the underlying step-up attempt counter increments (`STEP_UP_MAX_ATTEMPTS`
tracking is on FAILURES from `verifyMethod`, and an expired-OTP throw counts as a failure) — confirm
whether an innocent expiry (not a wrong guess) contributes to the same 5-strikes step-up lock as an
actual wrong code; per code it does (any thrown error in `verifyMethod` increments the Redis attempts
counter), which could lock out a slow-but-legitimate user (Open Questions §7-Q11).

**EDGE-016 / Maximum concurrent sessions — no explicit device/session cap observed in this module**
Steps: log in from 20+ distinct devices for one user.
Expected: no rejection at the mobile-auth layer itself — session/device count limits (if any) live in
the device-management module (`DeviceAccessRepository`/store-slot limits) referenced by
`revokeAllSlotsForDevice`, out of this module's direct scope but worth cross-checking there; confirm
whether an unbounded session list is intended or whether `sessions` pagination (max 100/page) is the
only practical ceiling on this endpoint's own behavior.

**EDGE-017 / Decimal/rounding — N/A for this module (no money/quantity fields)**
Confirmed no monetary or quantity rounding surfaces exist in mobile-auth; included only to document
the checklist item was considered and is not applicable here.

**EDGE-018 / Long-lived refresh token family depth — no explicit rotation-count cap observed**
Steps: rotate the same family 1,000+ times over its 30-day life.
Expected: each rotation creates a new `refreshTokens` row (`parentId` chain); no code caps chain
depth or periodically prunes it within this module (cleanup, if any, is `token-cleanup.service.ts`,
outside the read scope here) — confirm cron-based cleanup exists and runs, or unbounded row growth
per long-lived family is a known/accepted tradeoff.

**EDGE-019 / Two devices racing to be "first" to register the same public key for one user**
Steps: two processes call `upsertDevice` with the same `(userFk, publicKeyHash)` concurrently for a
brand-new key (no existing row) — e.g. two near-simultaneous logins from a freshly-installed app
using a deterministic/reused key.
Expected: `findByUserAndKeyHash` (outside a unique constraint, per the code shown) could let both see
"not existing" and both `insert` — verify whether a DB-level unique constraint on
`(userFk, publicKeyHash)` exists to prevent duplicate device rows; if not, this is a possible
duplicate-device race (Open Questions §7-Q12).

**EDGE-020 / Signature/back-navigation — client resubmits a step-up verify after already succeeding**
Steps: complete `step-up/verify` successfully, then resubmit the identical request (e.g. user hits
back and re-taps submit).
Expected: for `otp_sms`, the OTP is already consumed → `OTP_ALREADY_CONSUMED`, so the resubmit fails
cleanly rather than re-extending `valid_until`; for `biometric`, the challenge is already consumed →
`CHALLENGE_NOT_FOUND`. Either way, a resubmit can't silently re-arm step-up validity past what the
first success already granted.

**EDGE-021 / Rotation crossing exactly the ACCESS_TOKEN_TTL boundary**
Steps: hold an access token until 1 second before its 900s expiry, then make a guarded call; then
wait 2 more seconds and retry with the same token.
Expected: first call succeeds normally; second call → 401 `TOKEN_INVALID` (expired) — confirms the
15-minute boundary is enforced by `jose`'s `exp` check exactly, not by any of this module's own
timers.

**EDGE-022 / device.request platform enum boundary — 'web' accepted at the domain type level but not the wire DTO**
Note: `DeviceInfo.platform` (internal type) allows `'ios' | 'android' | 'web'`, but
`DeviceDtoSchema.platform` (wire-facing Zod schema) only allows `'ios' | 'android'`.
Steps: attempt `device.platform: "web"` on `login/verify`/`signup/verify`.
Expected: 422 validation error at the DTO layer — `'web'` can never actually reach the service today
via the mobile controller; flag as a documented mismatch between the domain type's optimism and the
wire contract's current restriction (Open Questions §7-Q13), relevant if a future web/POS-terminal
client is added.

---

## 5. Coverage summary (requirement/rule → covering cases)

| Rule / Requirement | Satisfied case(s) | Violated / negative case(s) |
|---|---|---|
| BR-1 phone-enumeration resistance | LOGIN-010 | LOGIN-011 |
| BR-2 OTP purpose isolation | OTP-005 | LOGIN-013, OTP-011 |
| BR-3 OTP single-use | LOGIN-001 | OTP-003, EDGE-020 |
| BR-4 OTP attempt cap (5) | OTP-001 | OTP-002, OTP-004 |
| BR-5 signup order-of-checks | LOGIN-021 | LOGIN-020 |
| BR-6 account lockout (5 / 30 min) | LOGIN-017, LOGIN-019 | LOGIN-016, LOGIN-018 |
| BR-7 blocked/suspended reject login | — | LOGIN-014, LOGIN-015 |
| BR-8 success clears lockout | LOGIN-019 | — |
| BR-9 device identity by key hash | LOGIN-004 | LOGIN-003 (contrast) |
| BR-10 session blacklist-able from mint | LOGIN-001 (setup) | JWT-006, JWT-008 |
| BR-11 refresh single-use + family revoke | REFRESH-001 | REFRESH-003, REFRESH-024 |
| BR-12 device proof mandatory | REFRESH-001 | REFRESH-004, REFRESH-005, REFRESH-006 |
| BR-13 currentJti mismatch → SESSION_REPLACED | — | JWT-008 |
| BR-14 logout releases slots, revokeSession doesn't | LOGOUT-001 | LOGOUT-009 |
| BR-15 logout-all atomic multi-session revoke | LOGOUT-003 | LOGOUT-004 (empty case) |
| BR-16 step-up per-session lockout | STEPUP-006 | STEPUP-005 |
| BR-17 step-up OTP targets own phone only | STEPUP-003 | — |
| BR-18 replay headers required everywhere | — | JWT-013, JWT-014, JWT-015 |
| BR-19 subscription guard skips reads/auth routes | SUB-001, SUB-013 | SUB-002–SUB-007 (writes blocked) |
| BR-20 snapshot delivery best-effort | REFRESH-002 | (degradation not independently testable without fault injection — see §7-Q14) |
| State: OTP request lifecycle | OTP-001 | OTP-002, OTP-003, LOGIN-012 |
| State: user account lock/unlock | LOGIN-017 | LOGIN-016, LOGIN-018 |
| State: device session lifecycle | REFRESH-001 | LOGOUT-001, JWT-007 |
| State: refresh-token family | REFRESH-001 | REFRESH-003, REFRESH-024 |
| Concurrency: idempotent refresh retry | REFRESH-020 | REFRESH-021 |
| Concurrency: true concurrent rotation race | REFRESH-022, REFRESH-023 | REFRESH-024 |
| Concurrency: OTP verify race | OTP-004 | — |
| Concurrency: signup same-phone race | SIGNUP-004 | — |
| Permission: session ownership | LOGOUT-005 | LOGOUT-007 |
| Cross-cutting: rate limits (IP/phone) | — | RL-001, RL-002 |
| Cross-cutting: dependency degradation (Redis down) | RL-003 (fallback works) | RL-004 (possible gap) |
| Cross-cutting: replay protection | JWT-015 | JWT-013, JWT-014 |
| Cross-cutting: time/expiry boundaries | JWT-003 boundary, EDGE-021 | REFRESH-008, EDGE-008 |

**Gaps identified (no fully-confirming case possible from static reading alone — need
runtime/instrumented verification):**
1. LOGIN-014/015 ordering of OTP-consumption vs. block/suspend checks — confirmed by code reading,
   but should be runtime-verified (does the OTP remain valid for a second attempt after the account
   is unblocked?).
2. RL-004 (otp_lock Redis-down behavior) — needs a fault-injection test; not confirmable by reading
   alone whether it throws 500 or degrades.
3. EDGE-019 (duplicate device row race) — needs either a DB schema check (unique constraint presence)
   or a live concurrency test; not resolved by the service-layer code alone.
4. BR-20 best-effort snapshot degradation — needs Redis/DB fault injection on the snapshot build path
   during login/signup/refresh to confirm the parent operation truly never fails.

---

## 6. Priority roll-up (run first)

**Critical (money/auth/data-integrity/concurrency) — must pass before any release:**
LOGIN-001, LOGIN-010, LOGIN-011, LOGIN-014, LOGIN-015, LOGIN-016, LOGIN-018, OTP-002, OTP-003,
OTP-004, SIGNUP-001, SIGNUP-004, REFRESH-001, REFRESH-003, REFRESH-004, REFRESH-005, REFRESH-006,
REFRESH-009, REFRESH-010, REFRESH-022, REFRESH-023, REFRESH-024, LOGOUT-001, LOGOUT-003, LOGOUT-007,
JWT-001, JWT-003, JWT-004, JWT-006, JWT-007, JWT-008, JWT-009, JWT-010, JWT-013, JWT-015, SUB-002,
SUB-003.

**High — core flows, common errors, offline correctness:**
LOGIN-002/003/012/013/017/019/020/021, OTP-001/006/007/011, RL-001/002/003, REFRESH-002/007/011/020,
LOGOUT-002/004/005/006/009/010, STEPUP-001/002/005/007, JWT-005/011/014/016, SUB-004/006/007/009/013,
EDGE-006/008/011/018/019.

**Medium/Low:** all remaining boundary/UX/documentation-style cases in §3–§4.

---

## 7. Open questions (need product/dev confirmation)

- **Q1 (§1.6):** Is a single, purpose-unscoped `rl:otp:{phone}` bucket (5 actions / 5 min, summed
  across login-otp, login-verify, signup-otp, signup-verify, step-up-verify) intentional? It seems
  tight enough to false-positive-block a legitimate user who mistypes twice and requests one resend.
- **Q2 (LOGIN-014/015):** Confirm whether a valid OTP is deliberately left unconsumed when a
  blocked/suspended user attempts login (so the same code can be reused once the block lifts, within
  its 5-minute TTL), or whether this is incidental.
- **Q3 (SIGNUP-005):** Is omitting `pushToken` from the session row created during signup (unlike
  login) intentional, or a bug? If unintentional, a freshly-signed-up device gets no push
  notifications until its first login/refresh.
- **Q4 (OTP-009):** Should `resend_of` referencing a nonexistent/garbage id enforce SOME cooldown
  (e.g. treat it as "no prior request, apply full cooldown from nothing" or reject outright), rather
  than silently skipping the cooldown check?
- **Q5 (RL-004):** Confirm actual behavior when the `otp_lock` Redis `SET NX` call itself throws
  (connection down) — does `requestOtp` 500, or is there upstream handling not visible in this file?
- **Q6 (REFRESH-010):** Confirm the asymmetry is intended: login only checks `isBlocked`/`suspended`
  status + the lockout timestamp, while refresh's `assertTokenUsable` rejects ANY `user.status !==
  'active'` (including `'locked'`) — meaning a locked-out user's existing session can't silently keep
  refreshing through the lockout window even though their JWT hasn't expired yet, but a login retry
  after lockout naturally expires would succeed. Confirm this stricter refresh-time check is by
  design (it reads as a deliberate defense-in-depth measure, not an oversight).
- **Q7 (LOGOUT-009):** Should `DELETE /sessions/:id` on the CALLER'S OWN current session also release
  device store-slots (matching `logout()`'s behavior), for parity? Currently only `logout()` does.
- **Q8 (EDGE-003):** Should `OtpVerifyDtoSchema.otp_code` be tightened to `z.string().regex(/^\d{6}$/)`
  instead of a bare `length(6)`, purely for input-validation hygiene (functionally harmless today
  since the hash comparison already rejects non-matching values)?
- **Q9 (EDGE-009):** Given real-world Android clock drift, is ±30s the right replay-protection
  window, or should the client be expected to NTP-sync before signing requests? Worth a support-ticket
  telemetry check post-launch.
- **Q10 (EDGE-013):** Confirm the accepted worst-case staleness window (up to 15 minutes, one access-
  token lifetime) between an RBAC/role change and it being reflected for a still-valid JWT, for
  actions that DO consult the JWT's embedded `pv` rather than a live snapshot lookup (if any exist
  outside this module).
- **Q11 (EDGE-015):** Should an OTP *expiring* (as opposed to a *wrong guess*) count toward the
  5-strikes step-up session lock? Currently both paths increment the same Redis counter.
- **Q12 (EDGE-019):** Confirm whether `devices` has a DB-level unique constraint on
  `(userFk, publicKeyHash)` — the service-layer `findByUserAndKeyHash`-then-`insert` pattern alone is
  TOCTOU-able without one (mirrors the exact race the code comments call out and defend against for
  `users.phone` in signup, but no equivalent comment/defense is visible for devices).
- **Q13 (EDGE-022):** `DeviceInfo.platform` (domain) allows `'web'`; `DeviceDtoSchema.platform` (wire)
  only allows `'ios' | 'android'`. Intentional restriction for the mobile-only client today, or drift
  to fix before a web/terminal client is added?
- **Q14 (BR-20 gap):** No fault-injection harness was available for static QA — recommend an explicit
  integration test that forces the Redis/DB snapshot-build path to throw during login/signup/refresh
  and asserts the parent operation still returns 200/201 with `snapshot: null`.