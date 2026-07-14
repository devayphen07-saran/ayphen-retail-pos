import type { WireRow } from '../../mappers/response/sync-wire.mapper.js';
import type { TombstoneWireRow } from '../../repositories/tombstone.repository.js';

/** GET /sync/initial response (sync-engine.md §5). */
export interface InitialPullResponse {
  entity_type: string | null;
  upserts: WireRow[];
  has_more: boolean;
  page_cursor: string | null;
  all_entities_complete: boolean;
  remaining_entity_types: string[];
  estimated_total?: number;
  next_delta_cursor?: string;
  server_time: string;
}

export interface EntityChangesResponse {
  upserts: WireRow[];
  deletes: TombstoneWireRow[];
}

/** GET /sync/changes response (sync-engine.md §7). */
export interface ChangesPullResponse {
  changes: Record<string, EntityChangesResponse>;
  sync_cursor: string;
  has_more: boolean;
  server_time: string;
}
