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
import { useAuthStore } from '@store';
import {
  classifyRefreshFailure,
  installAuthInterceptors,
  runRefresh,
  sanitizeError,
} from '../network/interceptors';
import { resetSubscriptionFreshness } from '../network/subscription-freshness';
import { getDevicePublicKey } from '../auth/device-key';
import {
  getAccessToken,
  getRefreshToken,
  saveTokens,
  clearTokens,
} from '../auth/token-store';
import { getLastOpenedStoreId } from '@features/store/shared/utils/prefs';

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

/** Every "session ended" checkpoint must clear the session store AND reset the
 *  subscription version baseline — the last-seen `X-Subscription-Version`
 *  belongs to the account that just logged out and must not leak into the next
 *  login on the same device. */
function clearSession(): void {
  useAuthStore.getState().clear();
  resetSubscriptionFreshness();
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
    console.warn('[auth] last-opened-store hydrate failed', sanitizeError(err));
    useAuthStore.getState().cacheLastOpenedStoreId(null);
  }
}

async function fetchBootstrap(isCancelled?: () => boolean): Promise<void> {
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

      console.warn('[auth] bootstrap fetch failed', sanitizeError(err));
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
      accessToken = await runRefresh();
    } catch (err) {
      if (isCancelled()) return;
      if (classifyRefreshFailure(err) === 'fatal') {
        console.warn('[auth] session rejected at launch — logging out', sanitizeError(err));
        await clearTokens();
        clearSession();
      } else {
        console.warn('[auth] launch restore failed transiently — will retry', sanitizeError(err));
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
    console.warn('[auth] launch restore failed', sanitizeError(err));
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
    );

    return dispose;
  }, [queryClient]);

  useEffect(() => {
    let cancelled = false;
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
          skipAuthRefresh: true,
        } as any,
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