/**
 * Session state — the single source of truth for "who is logged in" (Zustand,
 * per api-and-state-management.md §11/§12). Tokens are NOT here (see tokenStore).
 * This holds only ephemeral session flags, re-hydrated on launch.
 */
import { create } from 'zustand';
import type { AccountMode, PermissionSnapshot } from '@ayphen/api-manager';

type EmbeddedBootstrapInfo =
  | {
      snapshot: PermissionSnapshot;
      snapshotSignature: string;
      lastAccountMode: AccountMode | null;
      pendingInvitationCount: number;
    }
  | {
      snapshot?: undefined;
      snapshotSignature?: undefined;
      lastAccountMode?: undefined;
      pendingInvitationCount?: undefined;
    };

type SessionInfo = EmbeddedBootstrapInfo & {
  deviceSessionId: string;
  /**
   * `false` ⇒ AppGate routes to `/(onboarding)/complete-profile` before the
   * usual mode/store routing.
   *
   * Unlike the snapshot/bootstrap fields above, this is not part of the
   * "all together or none" group. It is computed from the user row and should
   * be supplied whenever the caller has it.
   */
  profileComplete?: boolean;
};

interface AuthState {
  /** null until the launch refresh/hydrate resolves — gate the splash on this. */
  isAuthReady: boolean;

  /**
   * false until bootstrap resolves.
   *
   * Auth readiness and bootstrap readiness are separate:
   * - isAuthReady: we know whether auth/session restore succeeded.
   * - isBootstrapped: we know mode/snapshot/invitation/profile routing data.
   */
  isBootstrapped: boolean;

  isAuthenticated: boolean;
  deviceSessionId: string | null;

  /** Opaque today — no on-device verification or offline gating reads this yet. */
  snapshot: PermissionSnapshot | null;
  snapshotSignature: string | null;

  /** null = user has not picked a mode yet → mode-chooser gate. */
  lastAccountMode: AccountMode | null;

  pendingInvitationCount: number;

  /**
   * Default true: only bootstrap/login should set this false, after they have
   * actually loaded the user row. Missing data must not trap the user in a gate.
   */
  profileComplete: boolean;

  /**
   * One-shot per login. Set when the user taps "Skip" on the complete-profile
   * gate so AppGate does not bounce them back during the same session.
   * Reset on every new login/session and logout.
   */
  profileGateAcknowledged: boolean;

  /**
   * Device-local "last opened store" cache, write-through from prefs.ts's
   * AsyncStorage read/writes.
   */
  lastOpenedStoreId: string | null;

  /** false until the launch hydrate or a write-through update has run. */
  isLastOpenedResolved: boolean;

  /**
   * Launch restore failed for a transient reason. Tokens are still presumed
   * present, so the app should render retry instead of redirecting to login.
   */
  restoreFailed: boolean;

  /**
   * Bootstrap exhausted its retries. AppGate should show retry instead of
   * falling through to mode-select on stale null data.
   */
  bootstrapFailed: boolean;

  /**
   * Protected path the user was bounced to login from. Consumed once after
   * login so the user resumes the intended route.
   */
  pendingReturnTo: string | null;

  /**
   * Store sub-route the user deep-linked into with no active store yet.
   * Consumed once by the store-enter flow.
   */
  pendingStoreRoute: string | null;

  setReady: () => void;
  setBootstrapped: () => void;
  setRestoreFailed: (failed: boolean) => void;
  setBootstrapFailed: (failed?: boolean) => void;
  cacheLastOpenedStoreId: (id: string | null) => void;
  setSession: (info: SessionInfo) => void;
  setSnapshot: (snapshot: PermissionSnapshot, signature: string) => void;
  setAccountMode: (mode: AccountMode) => void;
  setProfileComplete: () => void;
  acknowledgeProfileGate: () => void;
  setPendingReturnTo: (href: string | null) => void;
  consumePendingReturnTo: () => string | null;
  setPendingStoreRoute: (href: string | null) => void;
  consumePendingStoreRoute: () => string | null;
  clear: () => void;
}

const initialSessionState = {
  isAuthReady: false,
  isBootstrapped: false,
  isAuthenticated: false,
  deviceSessionId: null,
  snapshot: null,
  snapshotSignature: null,
  lastAccountMode: null,
  pendingInvitationCount: 0,
  profileComplete: true,
  profileGateAcknowledged: false,
  lastOpenedStoreId: null,
  isLastOpenedResolved: false,
  restoreFailed: false,
  bootstrapFailed: false,
  pendingReturnTo: null,
  pendingStoreRoute: null,
} satisfies Omit<
  AuthState,
  | 'setReady'
  | 'setBootstrapped'
  | 'setRestoreFailed'
  | 'setBootstrapFailed'
  | 'cacheLastOpenedStoreId'
  | 'setSession'
  | 'setSnapshot'
  | 'setAccountMode'
  | 'setProfileComplete'
  | 'acknowledgeProfileGate'
  | 'setPendingReturnTo'
  | 'consumePendingReturnTo'
  | 'setPendingStoreRoute'
  | 'consumePendingStoreRoute'
  | 'clear'
>;

const hasEmbeddedBootstrapInfo = (
  info: SessionInfo,
): info is SessionInfo & {
  snapshot: PermissionSnapshot;
  snapshotSignature: string;
  lastAccountMode: AccountMode | null;
  pendingInvitationCount: number;
} =>
  info.snapshot !== undefined &&
  info.snapshotSignature !== undefined &&
  info.lastAccountMode !== undefined &&
  info.pendingInvitationCount !== undefined;

export const useAuthStore = create<AuthState>((set, get) => ({
  ...initialSessionState,

  setReady: () => set({ isAuthReady: true }),

  setBootstrapped: () =>
    set({
      isBootstrapped: true,
      bootstrapFailed: false,
    }),

  setRestoreFailed: (failed) =>
    set({
      restoreFailed: failed,
      isAuthReady: true,
      ...(failed ? { isAuthenticated: false } : {}),
    }),

  setBootstrapFailed: (failed = true) =>
    set({
      bootstrapFailed: failed,
    }),

  cacheLastOpenedStoreId: (id) =>
    set({
      lastOpenedStoreId: id,
      isLastOpenedResolved: true,
    }),

  setSession: (info) => {
    const hasBootstrap = hasEmbeddedBootstrapInfo(info);

    set({
      isAuthReady: true,
      isAuthenticated: true,
      restoreFailed: false,
      bootstrapFailed: false,
      deviceSessionId: info.deviceSessionId,

      /**
       * A new login/session must ask again if the profile is still incomplete.
       * This matches the documented one-shot lifetime of profileGateAcknowledged.
       */
      profileGateAcknowledged: false,

      /**
       * If login/signup/restore carried embedded bootstrap data, mark bootstrap
       * complete immediately. If it did not, clear stale bootstrap data and make
       * AppGate wait for the explicit bootstrap call.
       */
      isBootstrapped: hasBootstrap,

      snapshot: hasBootstrap ? info.snapshot : null,
      snapshotSignature: hasBootstrap ? info.snapshotSignature : null,
      lastAccountMode: hasBootstrap ? info.lastAccountMode : null,
      pendingInvitationCount: hasBootstrap ? info.pendingInvitationCount : 0,

      ...(info.profileComplete !== undefined
        ? { profileComplete: info.profileComplete }
        : {}),
    });
  },

  setSnapshot: (snapshot, signature) =>
    set({
      snapshot,
      snapshotSignature: signature,
    }),

  setAccountMode: (mode) =>
    set({
      lastAccountMode: mode,
    }),

  setProfileComplete: () =>
    set({
      profileComplete: true,
      profileGateAcknowledged: false,
    }),

  acknowledgeProfileGate: () =>
    set({
      profileGateAcknowledged: true,
    }),

  setPendingReturnTo: (href) =>
    set({
      pendingReturnTo: href,
    }),

  consumePendingReturnTo: () => {
    const href = get().pendingReturnTo;
    if (href !== null) {
      set({ pendingReturnTo: null });
    }
    return href;
  },

  setPendingStoreRoute: (href) =>
    set({
      pendingStoreRoute: href,
    }),

  consumePendingStoreRoute: () => {
    const href = get().pendingStoreRoute;
    if (href !== null) {
      set({ pendingStoreRoute: null });
    }
    return href;
  },

  clear: () =>
    set({
      isAuthenticated: false,
      isBootstrapped: false,
      restoreFailed: false,
      bootstrapFailed: false,
      deviceSessionId: null,
      snapshot: null,
      snapshotSignature: null,
      lastAccountMode: null,
      pendingInvitationCount: 0,
      profileComplete: true,
      profileGateAcknowledged: false,
      pendingReturnTo: null,
      pendingStoreRoute: null,

      /**
       * Keep auth readiness true after logout/clear so the app can route to
       * login immediately instead of returning to splash.
       *
       * Keep lastOpenedStoreId untouched here only if prefs.ts owns clearing it.
       * If logout should forget the last store on this device, clear it in
       * prefs.ts and then call cacheLastOpenedStoreId(null).
       */
      isAuthReady: true,
    }),
}));
