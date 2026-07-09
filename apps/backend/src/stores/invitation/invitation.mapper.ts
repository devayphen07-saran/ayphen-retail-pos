import type { PendingInvitationRow } from './invitation.repository.js';
import type { AcceptInvitationResult, CreateInvitationResult } from './invitation.service.js';
import type {
  MyInvitationResponse,
  AcceptInvitationResponse,
  CreatedInvitationResponse,
  InvitationActionResponse,
} from './dto/invitation.response.js';

/** Pure domain → snake_case mapper (layered-architecture §3.7). */
export const InvitationMapper = {
  toCreatedResponse(result: CreateInvitationResult): CreatedInvitationResponse {
    return { id: result.id, token: result.token };
  },

  toActionResponse(): InvitationActionResponse {
    return { ok: true };
  },

  toAcceptInvitationResponse(result: AcceptInvitationResult): AcceptInvitationResponse {
    return {
      store_id:           result.storeId,
      snapshot:           result.snapshot,
      snapshot_signature: result.snapshotSignature,
    };
  },

  toMyInvitationResponse(r: PendingInvitationRow): MyInvitationResponse {
    return {
      id:         r.id,
      store_id:   r.storeId,
      store_name: r.storeName,
      role_name:  r.roleName,
      expires_at: r.expiresAt.toISOString(),
    };
  },
  toMyInvitationList(rows: PendingInvitationRow[]): MyInvitationResponse[] {
    return rows.map((r) => InvitationMapper.toMyInvitationResponse(r));
  },
};