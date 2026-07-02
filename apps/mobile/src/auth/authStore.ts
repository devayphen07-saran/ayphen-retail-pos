/**
 * Session state — the single source of truth for "who is logged in" (Zustand,
 * per api-and-state-management.md §11/§12). Tokens are NOT here (see tokenStore).
 * This holds only ephemeral session flags, re-hydrated on launch.
 */
import { create } from 'zustand';
import type { AuthUserResponse } from '@ayphen-retail/api-manager';

interface SessionInfo {
  user: AuthUserResponse;
  deviceGuuid: string;
  deviceSessionGuuid: string;
  isTrusted: boolean;
}

interface AuthState {
  /** null until the launch refresh/hydrate resolves — gate the splash on this. */
  isAuthReady: boolean;
  isAuthenticated: boolean;
  user: AuthUserResponse | null;
  deviceGuuid: string | null;
  deviceSessionGuuid: string | null;
  isTrusted: boolean;

  setReady: () => void;
  setSession: (info: SessionInfo) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthReady: false,
  isAuthenticated: false,
  user: null,
  deviceGuuid: null,
  deviceSessionGuuid: null,
  isTrusted: false,

  setReady: () => set({ isAuthReady: true }),

  setSession: (info) =>
    set({
      isAuthenticated: true,
      user: info.user,
      deviceGuuid: info.deviceGuuid,
      deviceSessionGuuid: info.deviceSessionGuuid,
      isTrusted: info.isTrusted,
    }),

  clear: () =>
    set({
      isAuthenticated: false,
      user: null,
      deviceGuuid: null,
      deviceSessionGuuid: null,
      isTrusted: false,
    }),
}));
