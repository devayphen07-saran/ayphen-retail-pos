/**
 * Axios interceptors for the shared `API` instance — the mobile session
 * lifecycle plumbing (api-manager CONVENTIONS §4 "Auth bootstrap plumbing":
 * refresh/logout/challenge run RAW via `API` + `.path`, outside react-query).
 *
 * Two interceptors:
 *  1. Request  — attach Authorization + the mandatory replay headers
 *                (x-nonce, x-timestamp). Without these EVERY authed request is
 *                rejected 401 REPLAY_DETECTED by MobileJwtGuard.
 *  2. Response — on 401, single-flight refresh via REFRESH.path, then retry once.
 */
import type {
  InternalAxiosRequestConfig,
  AxiosResponse,
  AxiosError,
} from 'axios';
import * as Crypto from 'expo-crypto';
import { API, REFRESH, type RefreshResponse } from '@ayphen-retail/api-manager';
import { getAccessToken, getRefreshToken, saveTokens, clearTokens } from './tokenStore';

// Paths that must NOT carry auth/replay headers (mirror api-data `public: true`).
const PUBLIC_PATHS = [
  'auth/mobile/login/otp',
  'auth/mobile/login/verify',
  'auth/mobile/signup/otp',
  'auth/mobile/signup/verify',
  'auth/mobile/refresh',
];

function isPublicPath(url?: string): boolean {
  if (!url) return false;
  return PUBLIC_PATHS.some((p) => url.includes(p));
}

// ── Replay headers ────────────────────────────────────────────────────────────

function makeNonce(): string {
  return Crypto.randomUUID();
}

function makeTimestamp(): string {
  // Backend tolerates ±30s drift. v1 uses OS time; add a server-time offset here
  // if REPLAY_DETECTED shows up in the field (no SERVER_TIME endpoint yet).
  return String(Date.now());
}

// ── Refresh single-flight ─────────────────────────────────────────────────────

let refreshInFlight: Promise<string | null> | null = null;

async function runRefresh(): Promise<string | null> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return null;

  // Raw call via the registry path — never hardcode (CONVENTIONS §4).
  const res = await API.post<RefreshResponse>(REFRESH.path, {
    refresh_token: refreshToken,
  });
  const { access_token, refresh_token } = res.data;
  await saveTokens(access_token, refresh_token);
  return access_token;
}

/**
 * Install both interceptors on the shared `API` instance. Returns a disposer.
 * `onAuthLost` is called when refresh fails (no/expired refresh token) so the
 * app can clear the auth store and route to login.
 */
export function installAuthInterceptors(onAuthLost: () => void): () => void {
  const reqId = API.interceptors.request.use(
    async (config: InternalAxiosRequestConfig) => {
      config.headers = config.headers ?? {};

      if (isPublicPath(config.url)) {
        return config;
      }

      const token = await getAccessToken();
      if (token) config.headers.Authorization = `Bearer ${token}`;

      // Mandatory on every authed request (ReplayProtectionService).
      config.headers['x-nonce'] = makeNonce();
      config.headers['x-timestamp'] = makeTimestamp();

      return config;
    },
  );

  const resId = API.interceptors.response.use(
    (res: AxiosResponse) => res,
    async (error: AxiosError) => {
      const original = error.config as
        | (InternalAxiosRequestConfig & { _retry?: boolean })
        | undefined;

      // Only handle a first 401 on a non-public, retriable request.
      if (
        error.response?.status !== 401 ||
        !original ||
        original._retry ||
        isPublicPath(original.url)
      ) {
        return Promise.reject(error);
      }

      original._retry = true;

      try {
        if (!refreshInFlight) {
          refreshInFlight = runRefresh().finally(() => {
            refreshInFlight = null;
          });
        }
        const newToken = await refreshInFlight;
        if (!newToken) throw new Error('refresh_failed');

        original.headers = original.headers ?? {};
        original.headers.Authorization = `Bearer ${newToken}`;
        // Fresh replay headers for the retry.
        original.headers['x-nonce'] = makeNonce();
        original.headers['x-timestamp'] = makeTimestamp();

        return API(original);
      } catch {
        await clearTokens();
        onAuthLost();
        return Promise.reject(error);
      }
    },
  );

  return () => {
    API.interceptors.request.eject(reqId);
    API.interceptors.response.eject(resId);
  };
}
