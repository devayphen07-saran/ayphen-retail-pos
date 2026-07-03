import type { SessionWithDevice } from '../repositories/auth-session.repository.js';
import type { StepUpResult } from '../services/step-up.service.js';
import type { CursorPage } from '#common/pagination/paginate.js';
import type { PaginatedResponse } from '#common/pagination/paginated-response.js';
import type {
  SessionResponse,
  StepUpResponse,
  ChallengeResponse,
} from '../dto/response/session.response.js';

/**
 * Maps device-session entities and step-up results to the snake_case
 * Response DTOs. Pure functions — no DI, no side effects. Only exposes
 * client-safe fields (never currentJti, tokenHash, or other secrets).
 */
export const SessionMapper = {
  toSessionResponse(s: SessionWithDevice, currentSessionId: string): SessionResponse {
    return {
      id:              s.id,
      device_name:     s.deviceName ?? s.device.model ?? null,
      os:              s.os ?? s.device.osVersion ?? null,
      platform:        s.platform ?? s.device.platform ?? null,
      app_version:     s.appVersion ?? null,
      ip_at_creation:  s.ipAtCreation ?? null,
      last_used_at:    s.lastUsedAt.toISOString(),
      last_step_up_at: s.lastStepUpAt?.toISOString() ?? null,
      created_at:      s.createdAt.toISOString(),
      is_current:      s.id === currentSessionId,
    };
  },

  toSessionListResponse(
    page: CursorPage<SessionWithDevice>,
    currentSessionId: string,
  ): PaginatedResponse<SessionResponse> {
    return {
      data:        page.items.map((s) => SessionMapper.toSessionResponse(s, currentSessionId)),
      next_cursor: page.nextCursor,
      has_more:    page.hasMore,
    };
  },

  toStepUpResponse(r: StepUpResult): StepUpResponse {
    return {
      ok:           r.ok,
      method:       r.method,
      completed_at: r.completedAt.toISOString(),
      valid_until:  r.validUntil.toISOString(),
    };
  },

  toChallengeResponse(challengeId: string): ChallengeResponse {
    return { challenge_id: challengeId };
  },
};
