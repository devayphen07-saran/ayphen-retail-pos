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
import { useAuthStore } from '@features/auth/authStore';

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

async function performRefresh(): Promise<string | null> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return null;

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
  // so the server can skip the payload when it's already current.
  const knownSnapshotVersion = useAuthStore.getState().snapshot?.permissionsVersion;
  const refreshRes = await API.post<{ data: RefreshResponse }>(REFRESH.path, {
    refresh_token: refreshToken,
    challenge_id: challengeId,
    device_signature: deviceSignature,
    snapshot_version: knownSnapshotVersion,
  });

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

  const candidate = data as { timestamp?: unknown };
  return typeof candidate.timestamp === 'string'
    ? candidate.timestamp
    : undefined;
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
export function installAuthInterceptors(onAuthLost: () => void): () => void {
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
      return response;
    },
    async (error: AxiosError) => {
      updateServerTimeOffset(extractEnvelopeTimestamp(error.response?.data));

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
        console.warn('[auth] refresh failed — logging out', sanitizeError(refreshError));
        await clearTokens();
        onAuthLost();
        return Promise.reject(error);
      }

      if (!newAccessToken) {
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
