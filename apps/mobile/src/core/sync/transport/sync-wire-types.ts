import type { WireRow } from '../repositories/synced-table.repository';

/**
 * Wire shapes verified directly against the backend (apps/backend/src/sync/
 * pull/{initial-sync,changes}.service.ts, push/delta.service.ts,
 * dto/response/conflict.response.ts) — not the PRDs, which have drifted from
 * the code before (no /sync/manifest endpoint; `retry_later` is real and
 * undocumented in mobile-11.md §6.3).
 */

export interface InitialResult {
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

export interface TombstoneWireRow {
  entity_type: string;
  guuid: string;
  entity_id: string | null;
  deleted_at: string;
  hard_delete: boolean;
}

export interface EntityChanges {
  upserts: WireRow[];
  deletes: TombstoneWireRow[];
}

export interface ChangesResult {
  changes: Record<string, EntityChanges>;
  sync_cursor: string;
  has_more: boolean;
  server_time: string;
}

export interface SyncMutationInput {
  mutation_id: string; // ULID
  entity_type: string;
  action: 'create' | 'update' | 'delete';
  payload: Record<string, unknown>;
  expected_row_version?: number; // required for action='update'
  client_modified_at?: string; // ISO with offset
  parent_guuid?: string;
}

/** The five-way result union (sync.constants.ts / delta.service.ts) —
 *  `retry_later` is transient and must NEVER be treated like `rejected`. */
export type MutationResultWire =
  | {
      mutation_id: string;
      status: 'applied';
      entity_id?: string;
      entity_guuid?: string;
      row_version?: number;
      data?: unknown;
    }
  | { mutation_id: string; status: 'duplicate'; cached: unknown }
  | {
      mutation_id: string;
      status: 'rejected';
      code: string;
      message: string;
      conflict_type?: string;
    }
  | {
      mutation_id: string;
      status: 'retry_later';
      code: string;
      message: string;
      conflict_type?: string;
    }
  | {
      mutation_id: string;
      status: 'conflict';
      conflict_type: 'MASTER_DATA';
      server_row: unknown;
      message: string;
    };

export interface SyncDeltaResult {
  mutation_results: MutationResultWire[];
  changes: Record<string, EntityChanges>;
  sync_cursor: string | null;
  has_more: boolean;
  server_time: string;
  permissions_version: number;
  snapshot?: unknown;
  snapshot_signature?: string;
}

export interface ConflictResponse {
  mutation_id: string;
  entity_type: string;
  entity_guuid: string | null;
  conflict_type: string;
  server_row: unknown;
  client_payload: unknown;
  message: string | null;
  status: string;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** Matches backend's PaginatedResponse<ConflictResponse> (common/pagination). */
export interface ConflictListResponse {
  data: ConflictResponse[];
  next_cursor: string | null;
  has_more: boolean;
}
