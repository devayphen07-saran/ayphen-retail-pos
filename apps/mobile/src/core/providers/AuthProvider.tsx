/**
 * AuthProvider — owns the session lifecycle:
 *  - installs the replay + refresh axios interceptors once
 *  - on launch: ensures a device key pair exists, then tries to restore a
 *    session by refreshing the stored refresh token
 *  - exposes login()/logout() that keep secure-store + Zustand in sync
 *
 * Tokens live in expo-secure-store (tokenStore); session flags live in Zustand
 * (authStore). This provider is the only place that wires them together.
 */
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API, LOGOUT, BOOTSTRAP, subscriptionKeys } from '@ayphen/api-manager';
import type { LoginResponse, BootstrapResponse } from '@ayphen/api-manager';
import { useAuthStore, useActiveStoreStore } from '@store';
import {
  bootstrapServerTimeOffset,
  classifyRefreshFailure,
  installAuthInterceptors,
  runRefresh,
  sanitizeError,
} from '../network/interceptors';
import { resetSubscriptionFreshness } from '../network/subscription-freshness';
import { resetPermissionFreshness } from '../network/permission-freshness';
import { getDevicePublicKey } from '../auth/device-key';
import {
  getAccessToken,
  getRefreshToken,
  saveTokens,
  clearTokens,
} from '../auth/token-store';
import { getLastOpenedStoreId } from '@features/store/shared/utils/prefs';
import { logger } from '../../utils/logger';

interface AuthContextType {
  isAuthReady: boolean;
  isAuthenticated: boolean;
  login: (res: LoginResponse) => Promise<void>;
  logout: () => Promise<void>;
  refetchUser: () => Promise<void>;
  /** Re-run the launch session restore after a transient failure (offline
   *  launch). Rendered by the entry gate's ConnectionGateScreen. */
  retryRestore: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Aggregate ceiling for the launch-time refresh/bootstrap chain — distinct
 *  from the shared axios instance's own 15s per-call timeout. Without this,
 *  refresh's own retry/backoff plus bootstrap's 2-attempt loop can each take
 *  up to ~30s, stacking into a ~60s+ apparent hang on a bad connection before
 *  either retry screen (ConnectionGateScreen off `restoreFailed`/
 *  `bootstrapFailed`) ever appears. */
const LAUNCH_TIMEOUT_MS = 8000;

class LaunchTimeoutError extends Error {
  constructor() {
    super('Launch operation exceeded its time budget');
    this.name = 'LaunchTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new LaunchTimeoutError()), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Every "session ended" checkpoint must clear the session store AND reset the
 *  subscription version baseline — the last-seen `X-Subscription-Version`
 *  belongs to the account that just logged out and must not leak into the next
 *  login on the same device. */
function clearSession(): void {
  useAuthStore.getState().clear();
  // Clear the active-store context centrally too, so a forced logout (refresh
  // rejected) can't leave the previous account's store/storeId populated for a
  // stale (store) render — teardown must not depend on the UI remembering to.
  useActiveStoreStore.getState().clearActiveStore();
  resetSubscriptionFreshness();
  resetPermissionFreshness();
}

/** Hydrates authStore's `lastOpenedStoreId` cache from AsyncStorage once at
 *  launch, so RootNavigator's splash gate and AppGate share one value instead
 *  of AppGate doing its own separate (and unguarded) AsyncStorage read. */
async function hydrateLastOpenedStoreId(isCancelled?: () => boolean): Promise<void> {
  try {
    const id = await getLastOpenedStoreId();
    if (isCancelled?.()) return;
    useAuthStore.getState().cacheLastOpenedStoreId(id);
  } catch (err) {
    if (isCancelled?.()) return;
    logger.warn('[auth] last-opened-store hydrate failed', sanitizeError(err));
    useAuthStore.getState().cacheLastOpenedStoreId(null);
  }
}

async function fetchBootstrap(isCancelled?: () => boolean): Promise<void> {
  try {
    await withTimeout(runBootstrapAttempts(isCancelled), LAUNCH_TIMEOUT_MS);
  } catch (err) {
    if (!(err instanceof LaunchTimeoutError)) throw err;
    if (isCancelled?.()) return;
    // The in-flight attempt keeps running in the background and will still
    // settle it later (success re-flips bootstrapped/bootstrapFailed;
    // failure is a harmless idempotent re-set) — this just stops the splash
    // from waiting the full ~30s worst case of the retry loop below.
    logger.warn('[auth] bootstrap fetch exceeded launch time budget');
    useAuthStore.getState().setBootstrapFailed();
  }
}

async function runBootstrapAttempts(isCancelled?: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (isCancelled?.()) return;

    try {
      const bootstrapRes = await API.get<{ data: BootstrapResponse }>(BOOTSTRAP.path);

      if (isCancelled?.()) return;

      const bootstrap = bootstrapRes.data.data;
      useAuthStore.getState().setSession({
        user: bootstrap.user,
        deviceId: bootstrap.device_id,
        deviceSessionId: bootstrap.device_session_id,
        isTrusted: bootstrap.is_trusted,
        snapshot: bootstrap.snapshot,
        snapshotSignature: bootstrap.snapshot_signature,
        lastAccountMode: bootstrap.last_account_mode,
        hasPendingInvitations: bootstrap.has_pending_invitations,
        pendingInvitationCount: bootstrap.pending_invitation_count,
      });
      useAuthStore.getState().setBootstrapped();

      return;
    } catch (err) {
      if (isCancelled?.()) return;

      if (attempt === 0) {
        await delay(2000);
        continue;
      }

      logger.warn('[auth] bootstrap fetch failed', sanitizeError(err));
      // Surface the failure instead of faking success — AppGate renders a
      // retry screen off `bootstrapFailed`. Marking bootstrapped here would
      // route a store owner to mode-select on stale null data; hanging the
      // gate forever is prevented by the flag, not by lying about the fetch
      // (flow-critic Phase 1, Trace 4).
      useAuthStore.getState().setBootstrapFailed();
    }
  }
}

/**
 * Launch-time session restore. Shared by the mount effect and the retry
 * screen. Token-destruction policy (flow-critic Phase 1): only a definitive
 * auth rejection clears secure-store — transient failures (offline, backend
 * down, local secure-store hiccup) set `restoreFailed` and keep the tokens
 * so a retry can succeed without re-login.
 */
async function attemptRestore(isCancelled: () => boolean): Promise<void> {
  try {
    await getDevicePublicKey();
    if (isCancelled()) return;

    const refreshToken = await getRefreshToken();
    if (!refreshToken) {
      useAuthStore.getState().setReady();
      return;
    }

    let accessToken: string | null = null;
    try {
      accessToken = await withTimeout(runRefresh(), LAUNCH_TIMEOUT_MS);
    } catch (err) {
      if (isCancelled()) return;
      // A timeout is by definition not a rejection the server ever issued —
      // never fatal, always the transient/retry path (never destroy tokens
      // for a connection that merely hasn't answered yet).
      if (err instanceof LaunchTimeoutError) {
        logger.warn('[auth] launch refresh exceeded time budget — will retry');
        useAuthStore.getState().setRestoreFailed(true);
      } else if (classifyRefreshFailure(err) === 'fatal') {
        logger.warn('[auth] session rejected at launch — logging out', sanitizeError(err));
        await clearTokens();
        clearSession();
      } else {
        logger.warn('[auth] launch restore failed transiently — will retry', sanitizeError(err));
        useAuthStore.getState().setRestoreFailed(true);
      }
      useAuthStore.getState().setReady();
      return;
    }

    if (isCancelled()) return;

    if (!accessToken) {
      // runRefresh only returns null when secure-store had no refresh token —
      // there is no session to preserve.
      await clearTokens();
      clearSession();
      useAuthStore.getState().setReady();
      return;
    }

    useAuthStore.setState({ isAuthenticated: true, restoreFailed: false });
    useAuthStore.getState().setReady();

    await Promise.all([
      fetchBootstrap(isCancelled),
      hydrateLastOpenedStoreId(isCancelled),
    ]);
  } catch (err) {
    // Local failure before/around the network step (secure-store read,
    // device-key generation). Not an auth rejection — never destroy tokens
    // for it; surface the retry screen instead.
    if (isCancelled()) return;
    logger.warn('[auth] launch restore failed', sanitizeError(err));
    useAuthStore.getState().setRestoreFailed(true);
    useAuthStore.getState().setReady();
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const isAuthReady = useAuthStore((s) => s.isAuthReady);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const queryClient = useQueryClient();

  useEffect(() => {
    const dispose = installAuthInterceptors(
      () => {
        // Session lost mid-flight: clear stores AND the query cache so the next
        // account on this device can't read the previous one's cached data.
        clearSession();
        queryClient.removeQueries();
      },
      () => {
        // Subscription version advanced (or a lapse was observed) — silent
        // background refetch; the banner/entitlements swap in-place.
        void queryClient.invalidateQueries({ queryKey: subscriptionKeys.detail() });
      },
      () => {
        // Permissions version advanced (role/permission change) — refetch
        // bootstrap for a fresh signed snapshot; local UX gates (usePermission)
        // pick it up automatically since they read straight from authStore.
        void fetchBootstrap();
      },
    );

    return dispose;
  }, [queryClient]);

  useEffect(() => {
    let cancelled = false;
    // Fire concurrently, not awaited — attemptRestore's first network call
    // (runRefresh) is on a public path unaffected by clock skew, so this
    // typically finishes calibrating the server-time offset well before
    // attemptRestore reaches its first AUTHENTICATED call (fetchBootstrap).
    // If it hasn't, that call still self-corrects via the interceptor's
    // own first-401 retry — see bootstrapServerTimeOffset's doc comment.
    void bootstrapServerTimeOffset();
    void attemptRestore(() => cancelled);

    return () => {
      cancelled = true;
    };
  }, []);

  const retryRestore = useCallback(async () => {
    // `restoreFailed` stays true during the attempt — the entry gate keeps
    // rendering the retry screen (its own busy spinner) instead of briefly
    // redirecting to login while unauthenticated. Success flips
    // isAuthenticated + restoreFailed together; a fatal rejection clears the
    // session, which resets the flag and routes to login.
    await attemptRestore(() => false);
  }, []);

  const login = useCallback(async (res: LoginResponse) => {
    await saveTokens(res.access_token, res.refresh_token);

    useAuthStore.getState().setSession({
      user: res.user,
      deviceId: res.device_id,
      deviceSessionId: res.device_session_id,
      isTrusted: res.is_trusted,
    });

    // LoginResponse carries tokens + basic identity only — no snapshot,
    // account mode, or invitations (those were added to bootstrap, not
    // login). The post-login routing gate reads those off `isBootstrapped`
    // and `isLastOpenedResolved`, so without this a fresh login leaves them
    // permanently false and the gate spins forever (only a cold-launch
    // relaunch runs these otherwise).
    await Promise.all([fetchBootstrap(), hydrateLastOpenedStoreId()]);
  }, []);

  const logout = useCallback(async () => {
    const token = await getAccessToken();

    await clearTokens();
    clearSession();
    queryClient.removeQueries();

    if (!token) return;

    try {
      await API.post(
        LOGOUT.path,
        undefined,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );
    } catch {
      // Best effort only. Local logout has already completed.
    }
  }, [queryClient]);

  const refetchUser = useCallback(() => fetchBootstrap(), []);

  return (
    <AuthContext.Provider
      value={{ isAuthReady, isAuthenticated, login, logout, refetchUser, retryRestore }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('[useAuth] Must be used inside <AuthProvider>.');
  return ctx;
}

export {
  getAccessToken,
  getRefreshToken,
  saveTokens,
  saveAccessToken,
  clearTokens,
} from '../auth/token-store';