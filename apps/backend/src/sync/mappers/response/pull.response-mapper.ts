import type { WireRow } from './sync-wire.mapper.js';
import type {
  InitialPullResponse,
  ChangesPullResponse,
  EntityChangesResponse,
} from '../../dto/response/pull.response.js';

/** Domain result computed by InitialSyncService.pull() — camelCase, pre-wire. */
export interface InitialPullDomainResult {
  entityType: string | null;
  upserts: WireRow[];
  hasMore: boolean;
  pageCursor: string | null;
  allEntitiesComplete: boolean;
  remainingEntityTypes: string[];
  estimatedTotal?: number;
  nextDeltaCursor?: string;
  serverTime: string;
}

/** Domain result computed by SyncChangesService.pull() — camelCase, pre-wire. */
export interface ChangesPullDomainResult {
  changes: Record<string, EntityChangesResponse>;
  syncCursor: string;
  hasMore: boolean;
  serverTime: string;
}

export const PullResponseMapper = {
  toInitialResponse(r: InitialPullDomainResult): InitialPullResponse {
    return {
      entity_type: r.entityType,
      upserts: r.upserts,
      has_more: r.hasMore,
      page_cursor: r.pageCursor,
      all_entities_complete: r.allEntitiesComplete,
      remaining_entity_types: r.remainingEntityTypes,
      ...(r.estimatedTotal !== undefined ? { estimated_total: r.estimatedTotal } : {}),
      ...(r.nextDeltaCursor !== undefined ? { next_delta_cursor: r.nextDeltaCursor } : {}),
      server_time: r.serverTime,
    };
  },

  toChangesResponse(r: ChangesPullDomainResult): ChangesPullResponse {
    return {
      changes: r.changes,
      sync_cursor: r.syncCursor,
      has_more: r.hasMore,
      server_time: r.serverTime,
    };
  },
};
