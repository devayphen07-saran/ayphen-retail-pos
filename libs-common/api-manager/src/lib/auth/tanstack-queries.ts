import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LOGIN_OTP,
  LOGIN_VERIFY,
  SIGNUP_OTP,
  SIGNUP_VERIFY,
  GET_SESSIONS,
  REVOKE_SESSION,
  LOGOUT,
  LOGOUT_ALL,
  STEP_UP_OTP,
  STEP_UP_VERIFY,
  ACCOUNT_MODE,
  PROFILE,
  UPDATE_PROFILE,
} from './api-data';
import type {
  OtpChallengeResponse,
  OtpRequest,
  OtpVerifyRequest,
  SignupVerifyRequest,
  LoginResponse,
  SessionResponse,
  Paginated,
  StepUpVerifyRequest,
  StepUpResponse,
  AccountModeRequest,
  ProfileResponse,
  UpdateProfileRequest,
} from './types';

/**
 * Auth hooks. Per api-manager CONVENTIONS §4, these are the ONLINE-ONLY actions
 * (OTP request/verify, login, signup, step-up, session management) — the correct
 * home for TanStack mutations/queries.
 *
 * NOT here (deliberately): REFRESH, LOGOUT cascade token handling, and
 * MOBILE_CHALLENGE for refresh device-signing. Those run RAW via `API` + `.path`
 * inside the mobile session lifecycle / axios interceptors (CONVENTIONS §4 row
 * "Auth bootstrap plumbing"), because they execute outside React and around the
 * token refresh flow. The `APIData` instances are exported from `./api-data` for
 * that use.
 */

// ── Query keys ───────────────────────────────────────────────────────────────

export const authKeys = {
  all: ['auth'] as const,
  sessions: () => [...authKeys.all, 'sessions'] as const,
};

// ── Login ────────────────────────────────────────────────────────────────────

/** Stage 1 — request a login OTP. */
export const useRequestLoginOtpMutation = () =>
  useMutation(LOGIN_OTP.mutationOptions<OtpChallengeResponse, OtpRequest>());

/** Stage 2 — verify login OTP + device, receive tokens. */
export const useVerifyLoginMutation = () =>
  useMutation(LOGIN_VERIFY.mutationOptions<LoginResponse, OtpVerifyRequest>());

// ── Signup ───────────────────────────────────────────────────────────────────

/** Stage 1 — request a signup OTP. */
export const useRequestSignupOtpMutation = () =>
  useMutation(SIGNUP_OTP.mutationOptions<OtpChallengeResponse, OtpRequest>());

/** Stage 2 — verify signup OTP, create account, receive tokens. */
export const useVerifySignupMutation = () =>
  useMutation(
    SIGNUP_VERIFY.mutationOptions<LoginResponse, SignupVerifyRequest>(),
  );

// ── Sessions ─────────────────────────────────────────────────────────────────

/** List active sessions for the current user. */
export const useSessionsQuery = (options?: { enabled?: boolean }) =>
  useQuery({
    ...GET_SESSIONS.queryOptions<Paginated<SessionResponse>>(),
    queryKey: authKeys.sessions(),
    enabled: options?.enabled ?? true,
  });

/** Revoke a specific session by id, then refresh the list. */
export const useRevokeSessionMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    REVOKE_SESSION.mutationOptions<void>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: authKeys.sessions() });
      },
    }),
  );
};

/** Revoke every session for the user. */
export const useLogoutAllMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    LOGOUT_ALL.mutationOptions<void>({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: authKeys.sessions() });
      },
    }),
  );
};

/**
 * Revoke the current session server-side. NOTE: this only tells the server to
 * blacklist the current JTI — the mobile app must still clear tokens from
 * secure-store and reset the auth store afterward (do that in the AuthProvider
 * `logout()`, not here).
 */
export const useLogoutMutation = () =>
  useMutation(LOGOUT.mutationOptions<void>());

// ── Account mode ─────────────────────────────────────────────────────────────

/** Set business/personal workspace mode (mobile-03 §3c/3d). */
export const useUpdateAccountModeMutation = () =>
  useMutation(ACCOUNT_MODE.mutationOptions<void, AccountModeRequest>());

// ── Profile ──────────────────────────────────────────────────────────────────

export const profileKeys = {
  all:    ['profile'] as const,
  detail: () => [...profileKeys.all, 'detail'] as const,
};

/** The profile screen's data — refetched fresh every time it mounts, not
 *  carried on the auth store the way BOOTSTRAP's routing fields are. */
export const useProfileQuery = (options?: { enabled?: boolean }) =>
  useQuery({
    ...PROFILE.queryOptions<ProfileResponse>(),
    queryKey: profileKeys.detail(),
    enabled: options?.enabled ?? true,
  });

/** Save profile fields (complete-profile gate + the profile screen's future
 *  edit action). Refreshes the cached profile with the server's response
 *  instead of refetching — the caller still owns updating authStore's
 *  `profileComplete` flag off the same response (see CompleteProfileScreen). */
export const useUpdateProfileMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    UPDATE_PROFILE.mutationOptions<ProfileResponse, UpdateProfileRequest>({
      onSuccess: (data) => {
        queryClient.setQueryData(profileKeys.detail(), data);
      },
    }),
  );
};

// ── Step-up ──────────────────────────────────────────────────────────────────

/** Step-up: request an OTP for a sensitive action. */
export const useStepUpOtpMutation = () =>
  useMutation(STEP_UP_OTP.mutationOptions<OtpChallengeResponse, OtpRequest>());

/** Step-up: verify and stamp recent-MFA on the session. */
export const useStepUpVerifyMutation = () =>
  useMutation(
    STEP_UP_VERIFY.mutationOptions<StepUpResponse, StepUpVerifyRequest>(),
  );
