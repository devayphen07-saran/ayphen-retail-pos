/**
 * Wire types for the invitation domain. Field names mirror the backend DTOs
 * (snake_case) exactly — see `apps/backend/src/stores/invitation.controller.ts`.
 */
import type { PermissionSnapshot } from '../auth/types';

export interface CreateInvitationRequest {
  role_id: string;
  phone?: string;
  email?: string;
}

export interface CreateInvitationResponse {
  id: string;
  token: string;
}

export interface MyInvitationResponse {
  id: string;
  store_id: string;
  store_name: string;
  role_name: string;
  expires_at: string;
}

export interface AcceptInvitationRequest {
  token: string;
}

export interface AcceptInvitationResponse {
  store_id: string;
  snapshot: PermissionSnapshot | null;
  snapshot_signature: string | null;
}

export interface RejectInvitationRequest {
  token: string;
}

export interface RejectInvitationResponse {
  ok: true;
}
