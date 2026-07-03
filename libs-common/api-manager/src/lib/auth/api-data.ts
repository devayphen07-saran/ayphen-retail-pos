import { APIData, APIMethod } from '../api-handler';

/**
 * Auth / OTP / device-session endpoints — all under the backend `auth/mobile/*`
 * surface (NestJS `MobileAuthController`). Stage-1 requests an OTP; stage-2
 * verifies it and issues the access + refresh token pair bound to the device.
 *
 * `public: true` strips the `Authorization` header — these run before (or
 * around) a valid access token exists.
 */

// ── Login (existing user) ────────────────────────────────────────────────────

/** Stage 1 — request a login OTP. Body: `{ phone, resend_of? }`. */
export const LOGIN_OTP = new APIData('auth/mobile/login/otp', APIMethod.POST, {
  public: true,
});

/** Stage 2 — verify login OTP + device, issue tokens. Body: `OtpVerifyRequest`. */
export const LOGIN_VERIFY = new APIData(
  'auth/mobile/login/verify',
  APIMethod.POST,
  { public: true },
);

// ── Signup (new user) ────────────────────────────────────────────────────────

/** Stage 1 — request a signup OTP. Body: `{ phone }`. */
export const SIGNUP_OTP = new APIData(
  'auth/mobile/signup/otp',
  APIMethod.POST,
  {
    public: true,
  },
);

/** Stage 2 — verify signup OTP, create user + device, issue tokens. Body: `SignupVerifyRequest`. */
export const SIGNUP_VERIFY = new APIData(
  'auth/mobile/signup/verify',
  APIMethod.POST,
  { public: true },
);

// ── Session lifecycle ────────────────────────────────────────────────────────

/**
 * Rotate the refresh token → new access + refresh pair.
 * Body: `RefreshRequest`. Public because it runs after the access token expires.
 * `challenge_id` + `device_signature` are optional device-binding proof.
 */
export const REFRESH = new APIData('auth/mobile/refresh', APIMethod.POST, {
  public: true,
});

/**
 * Device-binding challenge for refresh. Public — it runs after the access token
 * has expired, so it can't require one; the `refresh_token` in the body
 * identifies the device to challenge. Body: `RefreshChallengeRequest`.
 * Returns `{ challenge_id }` to sign with the device key, then pass to REFRESH.
 */
export const REFRESH_CHALLENGE = new APIData(
  'auth/mobile/refresh/challenge',
  APIMethod.POST,
  { public: true },
);

/** Revoke the current session (blacklists the current JTI). Auth required. */
export const LOGOUT = new APIData('auth/mobile/logout', APIMethod.POST);

/** Revoke every session for the user. Auth required. */
export const LOGOUT_ALL = new APIData('auth/mobile/logout/all', APIMethod.POST);

/** List active sessions (paginated: `?limit=&cursor=`). Auth required. */
export const GET_SESSIONS = new APIData('auth/mobile/sessions', APIMethod.GET);

/** Revoke one session by id. Path: `:id`. Auth required. */
export const REVOKE_SESSION = new APIData(
  'auth/mobile/sessions/:id',
  APIMethod.DELETE,
);

/**
 * Full session snapshot (user + device/session identifiers) for an already
 * authenticated principal. Auth required. Called from AuthProvider's
 * launch-time restore, right after `runRefresh()` succeeds — refresh returns
 * tokens only, so this fills in the `user` that a fresh login gets for free
 * from `LOGIN_VERIFY`/`SIGNUP_VERIFY`.
 */
export const BOOTSTRAP = new APIData('me/bootstrap', APIMethod.GET);

/** Set business/personal workspace mode. Body: `{ mode }`. Auth required. */
export const ACCOUNT_MODE = new APIData('me/account-mode', APIMethod.PATCH);

// ── Device challenge / step-up ───────────────────────────────────────────────

/**
 * Issue a device challenge (nonce) the device signs with its Ed25519 private
 * key — used for refresh device-binding and step-up. Auth required (call while
 * a token is still valid, e.g. proactive refresh). Returns `{ challenge_id }`.
 */
export const MOBILE_CHALLENGE = new APIData(
  'auth/mobile/step-up/challenge',
  APIMethod.POST,
);

/** Step-up: request an OTP for a sensitive action. Body: `{ phone }`. Auth required. */
export const STEP_UP_OTP = new APIData(
  'auth/mobile/step-up/otp',
  APIMethod.POST,
);

/** Step-up: verify the challenge/OTP, stamp `lastStepUpAt`. Body: `StepUpVerifyRequest`. Auth required. */
export const STEP_UP_VERIFY = new APIData(
  'auth/mobile/step-up/verify',
  APIMethod.POST,
);
