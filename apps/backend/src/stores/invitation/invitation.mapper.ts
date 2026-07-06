import type { PendingInvitationRow } from './invitation.repository.js';
import type { AcceptInvitationResult } from './invitation.service.js';
import type {
  MyInvitationResponse,
  AcceptInvitationResponse,
} from './dto/invitation.response.js';

/** Pure domain → snake_case mapper (layered-architecture §3.7). */
export const InvitationMapper = {
  toAcceptInvitationResponse(result: AcceptInvitationResult): AcceptInvitationResponse {
    return { store_id: result.storeId };
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