/**
 * Session state — the single source of truth for "who is logged in" (Zustand,
 * per api-and-state-management.md §11/§12). Tokens are NOT here (see tokenStore).
 * This holds only ephemeral session flags, re-hydrated on launch.
 */
import { create } from 'zustand';
import type { AccountMode, AuthUserResponse, PermissionSnapshot } from '@ayphen/api-manager';

interface SessionInfo {
  user: AuthUserResponse;
  deviceId: string;
  deviceSessionId: string;
  isTrusted: boolean;
  /** Only bootstrap provides these today — login doesn't carry them. */
  snapshot?: PermissionSnapshot;
  snapshotSignature?: string;
  lastAccountMode?: AccountMode | null;
  hasPendingInvitations?: boolean;
  pendingInvitationCount?: number;
}

interface AuthState {
  /** null until the launch refresh/hydrate resolves — gate the splash on this. */
  isAuthReady: boolean;
  /** false until bootstrap (mode, snapshot, invitations) resolves — bootstrap
   *  runs AFTER isAuthReady flips (non-blocking, see AuthProvider), so the
   *  post-login routing gate must wait on this separately, not isAuthReady. */
  isBootstrapped: boolean;
  isAuthenticated: boolean;
  user: AuthUserResponse | null;
  deviceId: string | null;
  deviceSessionId: string | null;
  isTrusted: boolean;
  /** Opaque today — no on-device verification or offline gating reads this yet. */
  snapshot: PermissionSnapshot | null;
  snapshotSignature: string | null;
  /** null = user hasn't picked a mode yet → mode-chooser gate. */
  lastAccountMode: AccountMode | null;
  hasPendingInvitations: boolean;
  pendingInvitationCount: number;
  /** Device-local "last opened store" cache, write-through from prefs.ts's
   *  AsyncStorage read/writes — lets the launch gate and AppGate share one
   *  value instead of AppGate doing its own separate AsyncStorage read. */
  lastOpenedStoreId: string | null;
  /** false until the launch hydrate (or a write-through update) has run. */
  isLastOpenedResolved: boolean;
  /** Launch restore failed for a TRANSIENT reason (offline, backend down) —
   *  tokens are still in secure-store and the session is presumed alive. The
   *  entry gate renders a retry screen instead of redirecting to login; only
   *  a definitive auth rejection ever clears tokens (flow-critic Phase 1). */
  restoreFailed: boolean;
  /** Bootstrap exhausted its retries — AppGate shows a retry screen instead
   *  of falling through to mode-select on stale null data. */
  bootstrapFailed: boolean;

  setReady: () => void;
  setBootstrapped: () => void;
  setRestoreFailed: (failed: boolean) => void;
  setBootstrapFailed: () => void;
  cacheLastOpenedStoreId: (id: string | null) => void;
  setSession: (info: SessionInfo) => void;
  /** Refresh only sends a snapshot when it changed — apply it without
   *  touching the rest of the session. */
  setSnapshot: (snapshot: PermissionSnapshot, signature: string) => void;
  /** Optimistic local update after a successful `PATCH /me/account-mode` —
   *  avoids a full bootstrap round-trip just to reflect the user's own choice. */
  setAccountMode: (mode: AccountMode) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthReady: false,
  isBootstrapped: false,
  isAuthenticated: false,
  user: null,
  deviceId: null,
  deviceSessionId: null,
  isTrusted: false,
  snapshot: null,
  snapshotSignature: null,
  lastAccountMode: null,
  hasPendingInvitations: false,
  pendingInvitationCount: 0,
  lastOpenedStoreId: null,
  isLastOpenedResolved: false,
  restoreFailed: false,
  bootstrapFailed: false,

  setReady: () => set({ isAuthReady: true }),

  setBootstrapped: () => set({ isBootstrapped: true, bootstrapFailed: false }),

  setRestoreFailed: (failed) => set({ restoreFailed: failed }),

  setBootstrapFailed: () => set({ bootstrapFailed: true }),

  cacheLastOpenedStoreId: (id) => set({ lastOpenedStoreId: id, isLastOpenedResolved: true }),

  setSession: (info) =>
    set({
      isAuthenticated: true,
      user: info.user,
      deviceId: info.deviceId,
      deviceSessionId: info.deviceSessionId,
      isTrusted: info.isTrusted,
      ...(info.snapshot ? { snapshot: info.snapshot } : {}),
      ...(info.snapshotSignature ? { snapshotSignature: info.snapshotSignature } : {}),
      ...(info.lastAccountMode !== undefined ? { lastAccountMode: info.lastAccountMode } : {}),
      ...(info.hasPendingInvitations !== undefined
        ? { hasPendingInvitations: info.hasPendingInvitations }
        : {}),
      ...(info.pendingInvitationCount !== undefined
        ? { pendingInvitationCount: info.pendingInvitationCount }
        : {}),
    }),

  setSnapshot: (snapshot, signature) =>
    set({ snapshot, snapshotSignature: signature }),

  setAccountMode: (mode) => set({ lastAccountMode: mode }),

  clear: () =>
    set({
      isAuthenticated: false,
      isBootstrapped: false,
      restoreFailed: false,
      bootstrapFailed: false,
      user: null,
      deviceId: null,
      deviceSessionId: null,
      isTrusted: false,
      snapshot: null,
      snapshotSignature: null,
      lastAccountMode: null,
      hasPendingInvitations: false,
      pendingInvitationCount: 0,
      lastOpenedStoreId: null,
      isLastOpenedResolved: false,
    }),
}));
