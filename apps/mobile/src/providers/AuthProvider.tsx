/**
 * AuthProvider — owns the session lifecycle:
 *  - installs the replay + refresh axios interceptors (once)
 *  - on launch: ensures a device key pair exists, then tries to restore a
 *    session by refreshing the stored refresh token
 *  - exposes login()/logout() that keep secure-store + the Zustand auth store
 *    in sync
 *
 * Tokens live in expo-secure-store (tokenStore); session flags in Zustand
 * (authStore). This provider is the only place that wires them together.
 */
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import { API, REFRESH, LOGOUT, type RefreshResponse } from '@ayphen-retail/api-manager';
import type { LoginResponse } from '@ayphen-retail/api-manager';
import { useAuthStore } from '../auth/authStore';
import { installAuthInterceptors } from '../auth/interceptors';
import { getDevicePublicKey } from '../auth/deviceKey';
import {
  getAccessToken,
  getRefreshToken,
  saveTokens,
  clearTokens,
} from '../auth/tokenStore';

interface AuthContextType {
  isAuthReady: boolean;
  isAuthenticated: boolean;
  /** Persist a verify/login response into secure-store + the session store. */
  login: (res: LoginResponse) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const isAuthReady = useAuthStore((s) => s.isAuthReady);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  // ── Install interceptors once ────────────────────────────────────────────
  useEffect(() => {
    const dispose = installAuthInterceptors(() => {
      useAuthStore.getState().clear();
    });
    return dispose;
  }, []);

  // ── Launch: ensure device key, then try to restore session ───────────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Generate the device key pair up front so it exists before any verify.
      await getDevicePublicKey();

      const refreshToken = await getRefreshToken();
      if (!refreshToken) {
        if (!cancelled) useAuthStore.getState().setReady();
        return;
      }

      try {
        const res = await API.post<RefreshResponse>(REFRESH.path, {
          refresh_token: refreshToken,
        });
        await saveTokens(res.data.access_token, res.data.refresh_token);
        // We only have tokens here, not the user profile. Mark authenticated;
        // the app shell fetches /me/bootstrap for the full session (future work).
        // For now flip the flag so routing lets the user in.
        if (!cancelled) {
          useAuthStore.setState({ isAuthenticated: true });
        }
      } catch {
        await clearTokens();
        if (!cancelled) useAuthStore.getState().clear();
      } finally {
        if (!cancelled) useAuthStore.getState().setReady();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Actions ──────────────────────────────────────────────────────────────
  const login = useCallback(async (res: LoginResponse) => {
    await saveTokens(res.access_token, res.refresh_token);
    useAuthStore.getState().setSession({
      user: res.user,
      deviceGuuid: res.device_guuid,
      deviceSessionGuuid: res.device_session_guuid,
      isTrusted: res.is_trusted,
    });
  }, []);

  const logout = useCallback(async () => {
    // Best-effort server-side revoke (needs a valid token + replay headers).
    try {
      const token = await getAccessToken();
      if (token) await API.post(LOGOUT.path);
    } catch {
      // ignore — we clear locally regardless
    }
    await clearTokens();
    useAuthStore.getState().clear();
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthReady, isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('[useAuth] Must be used inside <AuthProvider>.');
  return ctx;
}

// Back-compat token helpers (some call sites import these from the provider).
export {
  getAccessToken,
  getRefreshToken,
  saveTokens,
  saveAccessToken,
  clearTokens,
} from '../auth/tokenStore';
