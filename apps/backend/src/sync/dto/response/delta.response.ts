import type { ErrorCode } from '#common/error-codes.js';
import type { ConflictType } from '../../repositories/sync-conflict.repository.js';
import type { ChangesPullResponse } from './pull.response.js';

export type MutationResultWire =
  | { mutation_id: string; status: 'applied'; entity_id?: string; entity_guuid?: string; row_version?: number; data?: unknown }
  | { mutation_id: string; status: 'duplicate'; cached: unknown }
  | { mutation_id: string; status: 'rejected'; code: ErrorCode; message: string; conflict_type?: ConflictType }
  // A TRANSIENT block (subscription paused / reconciliation pending / not yet
  // loaded). Distinct from `rejected` on purpose: the server does NOT cache it
  // (the state can heal), so the CLIENT must keep the mutation queued and
  // re-push later — NEVER roll it back like a terminal `rejected` (a sale rung
  // during a lapse-then-renew would otherwise be silently lost). See §20/F2.
  | { mutation_id: string; status: 'retry_later'; code: ErrorCode; message: string; conflict_type?: ConflictType }
  | { mutation_id: string; status: 'conflict'; conflict_type: 'MASTER_DATA'; server_row: unknown; message: string };

/** POST /sync/delta response (sync-engine.md §9) — combined mutation push + delta pull. */
export interface SyncDeltaResponse {
  mutation_results: MutationResultWire[];
  changes: ChangesPullResponse['changes'];
  sync_cursor: string | null;
  has_more: boolean;
  server_time: string;
  permissions_version: number;
  snapshot?: unknown;
  snapshot_signature?: string;
}
