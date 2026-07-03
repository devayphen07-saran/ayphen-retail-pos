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
import { API, LOGOUT, BOOTSTRAP } from '@ayphen/api-manager';
import type { LoginResponse, BootstrapResponse } from '@ayphen/api-manager';
import { useAuthStore } from '@features/auth/authStore';
import { installAuthInterceptors, runRefresh, sanitizeError } from '../network/interceptors';
import { getDevicePublicKey } from '../auth/device-key';
import {
  getAccessToken,
  getRefreshToken,
  saveTokens,
  clearTokens,
} from '../auth/token-store';
import { getLastOpenedStoreId } from '@features/store/prefs';

interface AuthContextType {
  isAuthReady: boolean;
  isAuthenticated: boolean;
  login: (res: LoginResponse) => Promise<void>;
  logout: () => Promise<void>;
  refetchUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      // Mark bootstrapped even on failure — the routing gate must not hang
      // forever waiting on a bootstrap that keeps failing. Worst case: the
      // gate falls back to its null-mode default (mode chooser).
      useAuthStore.getState().setBootstrapped();
    }
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const isAuthReady = useAuthStore((s) => s.isAuthReady);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  useEffect(() => {
    const dispose = installAuthInterceptors(() => {
      useAuthStore.getState().clear();
    });

    return dispose;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;

    (async () => {
      try {
        await getDevicePublicKey();

        if (cancelled) return;

        const refreshToken = await getRefreshToken();
        if (!refreshToken) {
          useAuthStore.getState().setReady();
          return;
        }

        try {
          const accessToken = await runRefresh();
          if (!accessToken) throw new Error('Refresh returned no access token');

          if (cancelled) return;

          useAuthStore.setState({ isAuthenticated: true });
          useAuthStore.getState().setReady();

          await Promise.all([
            fetchBootstrap(isCancelled),
            hydrateLastOpenedStoreId(isCancelled),
          ]);
        } catch (err) {
          await clearTokens();

          if (!cancelled) {
            useAuthStore.getState().clear();
            useAuthStore.getState().setReady();
          }
        }
      } catch (err) {
        console.warn('[auth] launch restore failed', sanitizeError(err));

        await clearTokens();

        if (!cancelled) {
          useAuthStore.getState().clear();
          useAuthStore.getState().setReady();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
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
    useAuthStore.getState().clear();

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
  }, []);

  const refetchUser = useCallback(() => fetchBootstrap(), []);

  return (
    <AuthContext.Provider value={{ isAuthReady, isAuthenticated, login, logout, refetchUser }}>
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