/**
 * Axios interceptors for the shared `API` instance.
 *
 * Responsibilities:
 *  1. Request interceptor
 *     - attach Authorization when an access token exists
 *     - attach replay-protection headers (x-nonce, x-timestamp) on non-public requests
 *
 *  2. Response interceptor
 *     - learn server clock offset from response.timestamp
 *     - on first 401 for a non-public request, run single-flight refresh
 *     - retry the original request once with fresh token + fresh replay headers
 *
 * Notes:
 * - login / signup / refresh / refresh-challenge must stay raw and unauthenticated
 * - refresh failure means the session is lost → clear local tokens + notify caller
 * - retry failure is NOT treated as auth-loss unless refresh itself failed
 */

import type {
  InternalAxiosRequestConfig,
  AxiosResponse,
  AxiosError,
  AxiosRequestHeaders,
} from 'axios';
import axios from 'axios';
import * as Crypto from 'expo-crypto';
import {
  API,
  REFRESH,
  REFRESH_CHALLENGE,
  type RefreshResponse,
  type ChallengeResponse,
} from '@ayphen/api-manager';

import {
  getAccessToken,
  getRefreshToken,
  saveTokens,
  clearTokens,
} from '../auth/token-store';
import { signChallenge } from '../auth/device-key';
import { useAuthStore } from '@store';
import { observeSubscriptionVersion } from './subscription-freshness';
import { observePermissionsVersion } from './permission-freshness';
import { logger } from '../../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Public endpoints
// ─────────────────────────────────────────────────────────────────────────────

const PUBLIC_PATHS = new Set<string>([
  'auth/mobile/login/otp',
  'auth/mobile/login/verify',
  'auth/mobile/signup/otp',
  'auth/mobile/signup/verify',
  'auth/mobile/refresh',
  'auth/mobile/refresh/challenge',
  'time',
]);

function normalizePath(url?: string): string {
  if (!url) return '';

  // Remove origin if present
  let path = url.replace(/^https?:\/\/[^/]+/i, '');

  // Remove query/hash
  path = path.split('?')[0]!.split('#')[0]!;

  // Remove leading slash
  path = path.replace(/^\/+/, '');

  return path;
}

function isPublicPath(url?: string): boolean {
  const normalized = normalizePath(url);
  return PUBLIC_PATHS.has(normalized);
}

// ─────────────────────────────────────────────────────────────────────────────
// Replay headers
// ─────────────────────────────────────────────────────────────────────────────

function makeNonce(): string {
  return Crypto.randomUUID();
}

/**
 * Server-time correction.
 *
 * Backend replay protection validates x-timestamp against SERVER time, not
 * device-local time. If the device clock drifts, every authenticated request
 * can fail with replay/timestamp errors. We learn the offset from the server
 * response envelope timestamp and apply it to future requests.
 */
let serverTimeOffsetMs = 0;

function updateServerTimeOffset(serverIso?: string): void {
  if (!serverIso) return;

  const serverMs = Date.parse(serverIso);
  if (Number.isNaN(serverMs)) return;

  serverTimeOffsetMs = serverMs - Date.now();
}

function makeTimestamp(): string {
  return String(Date.now() + serverTimeOffsetMs);
}

/**
 * Best-effort clock-skew bootstrap — learns the server offset from the
 * public, unauthenticated `GET /time` (time.controller.ts) BEFORE the first
 * authenticated request goes out. Not required for correctness: the response
 * interceptor below already calls `updateServerTimeOffset` on EVERY response
 * (success or error — error envelopes carry a `timestamp` too), and the
 * generic first-401 retry re-issues the original request with a fresh
 * timestamp — so a skewed device still self-corrects after one extra round
 * trip even if this never ran. This just avoids paying that round trip (and
 * a REPLAY_DETECTED entry in the logs) on every cold launch. Call once, fire-
 * and-forget, alongside launch-time session restore — `/time` doesn't wrap
 * its response in the usual envelope (`@SkipTransform()` server-side), so it
 * can't reuse `extractEnvelopeTimestamp`.
 */
export async function bootstrapServerTimeOffset(): Promise<void> {
  try {
    const res = await API.get<{ server_time: string }>('time');
    updateServerTimeOffset(res.data?.server_time);
  } catch {
    // Offline or the server is unreachable at launch — the self-heal path
    // above (learn-from-error-response + first-401 retry) is the fallback.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error sanitization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip an Axios error down to loggable fields only. `error.config.headers`
 * carries the original request's `Authorization: Bearer <token>` — logging
 * the raw error risks the token reaching device logs / a future crash
 * reporter that serializes console output.
 */
export function sanitizeError(err: unknown): unknown {
  if (!err || typeof err !== 'object') return err;
  const e = err as Partial<AxiosError> & { message?: string };
  if (!('isAxiosError' in e) || !e.isAxiosError) return err;
  return {
    message: e.message,
    status: e.response?.status,
    code: (e.response?.data as { code?: string } | undefined)?.code ?? e.code,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh single-flight
// ─────────────────────────────────────────────────────────────────────────────

let refreshInFlight: Promise<string | null> | null = null;

/**
 * Full device-proof refresh: fetch a challenge for the stored refresh token,
 * sign it with the device key, rotate tokens. Shared by the response
 * interceptor (401 retry) and AuthProvider's launch-time session restore —
 * both must prove device possession the same way, or refresh fails with
 * DEVICE_PROOF_REQUIRED. Single-flight: concurrent callers (e.g. a fast
 * remount racing the launch effect) share one in-flight rotation instead of
 * each rotating the refresh token independently, which would make the loser's
 * token stale.
 */
export function runRefresh(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * The backend's own refresh-rotation idempotency layer returns this code
 * (503) when a concurrent rotation for the same token is still in flight and
 * its 3s poll window expired — a signal to retry shortly, NOT a real failure.
 * Proceeding to rotate independently here would race the still-in-flight
 * leader's compare-and-swap and get treated as REFRESH_TOKEN_REUSE, which
 * revokes the whole token family over nothing more than backend latency
 * (flow-critic review, Finding A). Must be retried, never surfaced as a
 * refresh failure.
 */
const REFRESH_IN_PROGRESS_CODE = 'refresh_in_progress_retry';
const REFRESH_RETRY_ATTEMPTS = 3;
const REFRESH_RETRY_DELAY_MS = 400;

function isRefreshInProgress(err: unknown): boolean {
  return (
    axios.isAxiosError(err) &&
    (err.response?.data as { errorCode?: string } | undefined)?.errorCode === REFRESH_IN_PROGRESS_CODE
  );
}

/**
 * Wire codes from the refresh flow that mean the session is DEFINITIVELY dead:
 * retrying can never succeed, so clearing tokens and routing to login is the
 * only correct response. Everything else — no response (offline), 5xx, 429,
 * REFRESH_IN_PROGRESS after retries, malformed envelopes — is transient: the
 * refresh token in secure-store is still presumed valid and MUST survive.
 *
 * Source of truth: refresh-token.service.ts (issueRefreshChallenge + rotate)
 * on the backend. The global exception filter lowercases the SCREAMING_SNAKE
 * messages into `errorCode`, so this set is lowercase.
 */
const FATAL_REFRESH_CODES = new Set([
  'refresh_token_revoked',
  'refresh_token_reuse',
  'refresh_token_expired',
  'session_revoked',
  'session_expired',
  'user_not_found',
  'user_suspended',
  'device_not_found',
  'device_proof_required',
  'device_signature_invalid',
]);

/** Consumed/expired device challenge — retryable, but only with a FRESH
 *  challenge (e.g. a failed leader consumed ours before erroring out). */
const CHALLENGE_NOT_FOUND_CODE = 'challenge_not_found';

export type RefreshFailureKind = 'fatal' | 'transient';

/**
 * Fatal only on an explicit definitive-rejection code. Defaulting to
 * 'transient' is the fail-safe direction: a truly dead session keeps
 * surfacing its fatal code on every subsequent refresh attempt, so the worst
 * case of a miss here is one extra retry cycle — whereas defaulting to
 * 'fatal' turns every patch of bad network into a forced re-login.
 */
export function classifyRefreshFailure(err: unknown): RefreshFailureKind {
  if (!axios.isAxiosError(err) || !err.response) return 'transient';
  const { code } = extractErrorCode(err.response.data);
  return code && FATAL_REFRESH_CODES.has(code) ? 'fatal' : 'transient';
}

function isChallengeNotFound(err: unknown): boolean {
  if (!axios.isAxiosError(err) || !err.response) return false;
  return extractErrorCode(err.response.data).code === CHALLENGE_NOT_FOUND_CODE;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST /refresh, retrying a bounded number of times on REFRESH_IN_PROGRESS. */
async function postRotationWithRetry(
  refreshToken: string,
  challengeId: string,
  deviceSignature: string,
  snapshotVersion: number | undefined,
): Promise<AxiosResponse<{ data: RefreshResponse }>> {
  for (let attempt = 1; attempt <= REFRESH_RETRY_ATTEMPTS; attempt++) {
    try {
      return await API.post<{ data: RefreshResponse }>(REFRESH.path, {
        refresh_token: refreshToken,
        challenge_id: challengeId,
        device_signature: deviceSignature,
        snapshot_version: snapshotVersion,
      });
    } catch (err) {
      if (!isRefreshInProgress(err) || attempt === REFRESH_RETRY_ATTEMPTS) throw err;
      await delay(REFRESH_RETRY_DELAY_MS * attempt);
    }
  }
  // Unreachable — the loop always returns or throws — but satisfies TS.
  throw new Error('Refresh retry loop exited unexpectedly');
}

async function performRefresh(): Promise<string | null> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return null;

  try {
    return await rotateWithFreshChallenge(refreshToken);
  } catch (err) {
    // CHALLENGE_NOT_FOUND means our challenge was consumed or expired server-
    // side (typically: a previous rotation attempt consumed it before failing
    // transiently, or the device slept past the challenge TTL). The refresh
    // token itself is untouched — one full re-attempt with a fresh challenge
    // recovers; anything else propagates unchanged.
    if (!isChallengeNotFound(err)) throw err;
    return await rotateWithFreshChallenge(refreshToken);
  }
}

async function rotateWithFreshChallenge(refreshToken: string): Promise<string | null> {
  // Step 1: get refresh challenge.
  // Raw `API` calls bypass APIData's envelope unwrapping — the backend's
  // global ResponseInterceptor wraps every payload as `{ success, data, ... }`,
  // so the real body is `.data.data`, not `.data`.
  const challengeRes = await API.post<{ data: ChallengeResponse }>(
    REFRESH_CHALLENGE.path,
    { refresh_token: refreshToken },
  );

  const challengeId = challengeRes.data.data.challenge_id;
  if (!challengeId) {
    throw new Error('Refresh challenge response missing challenge_id');
  }

  // Step 2: prove device key possession
  const deviceSignature = await signChallenge(challengeId);

  // Step 3: rotate tokens. Send the last-known snapshot's permissionsVersion
  // so the server can skip the payload when it's already current. Retried a
  // bounded number of times on REFRESH_IN_PROGRESS — anything else rethrows
  // immediately (unchanged failure semantics for genuine errors).
  const knownSnapshotVersion = useAuthStore.getState().snapshot?.permissionsVersion;
  const refreshRes = await postRotationWithRetry(refreshToken, challengeId, deviceSignature, knownSnapshotVersion);

  const accessToken = refreshRes.data.data.access_token;
  const nextRefreshToken = refreshRes.data.data.refresh_token;

  if (!accessToken || !nextRefreshToken) {
    throw new Error('Refresh response missing tokens');
  }

  await saveTokens(accessToken, nextRefreshToken);

  const { snapshot, snapshot_signature } = refreshRes.data.data;
  if (snapshot && snapshot_signature) {
    useAuthStore.getState().setSnapshot(snapshot, snapshot_signature);
  }

  return accessToken;
}

// ─────────────────────────────────────────────────────────────────────────────
// Axios retry config extension
// ─────────────────────────────────────────────────────────────────────────────

type RetriableConfig = InternalAxiosRequestConfig & {
  _retry?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function ensureHeaders(
  config: InternalAxiosRequestConfig,
): AxiosRequestHeaders {
  const headers = (config.headers ?? {}) as AxiosRequestHeaders;
  config.headers = headers;
  return headers;
}

function extractEnvelopeTimestamp(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;

  // Most endpoints wrap the response in the standard envelope (`timestamp`).
  // The sync controller is `@SkipTransform()` — its responses carry
  // `server_time` directly instead, so without this fallback, clock-skew
  // correction never fires from sync traffic (only from the one-time launch
  // bootstrap and any other non-sync call the app happens to make).
  const candidate = data as { timestamp?: unknown; server_time?: unknown };
  if (typeof candidate.timestamp === 'string') return candidate.timestamp;
  if (typeof candidate.server_time === 'string') return candidate.server_time;
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription freshness (subscription.md §16/§19)
// ─────────────────────────────────────────────────────────────────────────────

/** Error codes SubscriptionStatusGuard emits on a blocked write. Wire codes are
 *  always lowercased by the global exception filter regardless of how the
 *  guard cased the thrown message. */
const SUBSCRIPTION_LAPSED_CODES = new Set(['subscription_payment_required', 'subscription_suspended']);

/** The subscription-detail query's own path — a lapse error ON this endpoint
 *  must NOT trigger a refetch of it, or the invalidate loops. */
const SUBSCRIPTION_DETAIL_PATH = 'me/subscription';

function readSubscriptionHeaders(
  headers: AxiosResponse['headers'] | undefined,
  onSubscriptionStale: () => void,
): void {
  if (!headers) return;
  const version = headers['x-subscription-version'];
  if (typeof version === 'string') {
    const n = Number(version);
    // observeSubscriptionVersion returns true only when the version actually
    // advanced — dedupes duplicate/out-of-order headers so we refetch once.
    if (Number.isFinite(n) && observeSubscriptionVersion(n)) {
      onSubscriptionStale();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Permissions freshness (rbac.md — X-Permissions-Version)
// ─────────────────────────────────────────────────────────────────────────────

function readPermissionsHeaders(
  headers: AxiosResponse['headers'] | undefined,
  onPermissionsStale: () => void,
): void {
  if (!headers) return;
  const version = headers['x-permissions-version'];
  if (typeof version === 'string') {
    const n = Number(version);
    // observePermissionsVersion returns true only when the version actually
    // advanced — dedupes duplicate/out-of-order headers so we refetch once.
    if (Number.isFinite(n) && observePermissionsVersion(n)) {
      onPermissionsStale();
    }
  }
}

/** Pull `{ code, details }` out of the backend's `{ error: { errorCode, ... } }`
 *  (or root-level) error envelope — mirrors api-manager's own `normalizeError`
 *  since this module doesn't import that package (network/ sits below it). */
function extractErrorCode(data: unknown): { code: string | undefined; details: unknown } {
  if (!data || typeof data !== 'object') return { code: undefined, details: undefined };
  const body = data as { error?: { errorCode?: string; code?: string; details?: unknown }; errorCode?: string; code?: string };
  const payload = body.error && typeof body.error === 'object' ? body.error : body;
  const code = payload.errorCode ?? payload.code;
  return { code: code?.toLowerCase(), details: (payload as { details?: unknown }).details };
}

/** React to a 402/403 on the response: subscription-lapse codes force a
 *  refetch even when the version header didn't advance (the guard's soft
 *  "access window closed" path doesn't bump `subscription_version` itself —
 *  only the reconciliation cron does — so relying on the version alone would
 *  leave the client showing a stale "active" banner past the actual cutoff). */
function observeSubscriptionError(
  status: number | undefined,
  data: unknown,
  requestUrl: string | undefined,
  onSubscriptionStale: () => void,
): void {
  if (status !== 402 && status !== 403) return;
  const { code } = extractErrorCode(data);
  if (!code) return;
  if (SUBSCRIPTION_LAPSED_CODES.has(code)) {
    // Never force a subscription refetch in response to an error ON the
    // subscription query itself — the one input that could loop
    // (invalidate → refetch → 402 → invalidate).
    if (normalizePath(requestUrl) === SUBSCRIPTION_DETAIL_PATH) return;
    onSubscriptionStale();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Installer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Install auth interceptors on the shared API instance.
 *
 * `onAuthLost` should clear any app-level auth state and route the user to login.
 * It is called only when refresh definitively fails or no refresh token exists.
 */
export function installAuthInterceptors(
  onAuthLost: () => void,
  onSubscriptionStale: () => void,
  onPermissionsStale: () => void,
): () => void {
  const requestInterceptorId = API.interceptors.request.use(
    async (config: InternalAxiosRequestConfig) => {
      const headers = ensureHeaders(config);

      if (isPublicPath(config.url)) {
        // Never attach stale auth or replay headers to public/auth bootstrap endpoints.
        delete headers.Authorization;
        delete headers.authorization;
        delete headers['x-nonce'];
        delete headers['x-timestamp'];
        return config;
      }

      const accessToken = await getAccessToken();
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      } else {
        delete headers.Authorization;
        delete headers.authorization;
      }

      // Required by backend replay protection on authenticated mobile requests.
      headers['x-nonce'] = makeNonce();
      headers['x-timestamp'] = makeTimestamp();

      return config;
    },
  );

  const responseInterceptorId = API.interceptors.response.use(
    (response: AxiosResponse) => {
      updateServerTimeOffset(extractEnvelopeTimestamp(response.data));
      readSubscriptionHeaders(response.headers, onSubscriptionStale);
      readPermissionsHeaders(response.headers, onPermissionsStale);
      return response;
    },
    async (error: AxiosError) => {
      updateServerTimeOffset(extractEnvelopeTimestamp(error.response?.data));
      readSubscriptionHeaders(error.response?.headers, onSubscriptionStale);
      readPermissionsHeaders(error.response?.headers, onPermissionsStale);
      observeSubscriptionError(error.response?.status, error.response?.data, error.config?.url, onSubscriptionStale);

      const original = error.config as RetriableConfig | undefined;

      // Retry only:
      // - first 401
      // - non-public request
      // - request still exists
      if (
        error.response?.status !== 401 ||
        !original ||
        original._retry === true ||
        isPublicPath(original.url)
      ) {
        return Promise.reject(error);
      }

      original._retry = true;

      let newAccessToken: string | null = null;

      try {
        newAccessToken = await runRefresh();
      } catch (refreshError) {
        // Only a definitive rejection from the refresh endpoint may end the
        // session. Transient faults (offline, 5xx, timeout, in-progress after
        // retries) keep tokens — the request fails as a plain network error
        // and the NEXT 401 simply tries refresh again. Destroying a valid
        // refresh token over network weather forces a re-OTP login at the
        // counter (flow-critic Phase 1, Trace 1).
        if (classifyRefreshFailure(refreshError) === 'fatal') {
          logger.warn('[auth] refresh rejected — logging out', sanitizeError(refreshError));
          await clearTokens();
          onAuthLost();
        } else {
          logger.warn('[auth] refresh failed transiently — keeping session', sanitizeError(refreshError));
        }
        return Promise.reject(error);
      }

      if (!newAccessToken) {
        // runRefresh only returns null when no refresh token exists in
        // secure-store — there is genuinely no session to preserve.
        await clearTokens();
        onAuthLost();
        return Promise.reject(error);
      }

      // Retry original request once with fresh token + fresh replay headers.
      const headers = ensureHeaders(original);
      headers.Authorization = `Bearer ${newAccessToken}`;
      headers['x-nonce'] = makeNonce();
      headers['x-timestamp'] = makeTimestamp();

      return API(original);
    },
  );

  return () => {
    API.interceptors.request.eject(requestInterceptorId);
    API.interceptors.response.eject(responseInterceptorId);
  };
}
