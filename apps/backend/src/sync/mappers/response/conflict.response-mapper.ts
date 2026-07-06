import type { SyncConflictRow } from '../../repositories/sync-conflict.repository.js';
import type { ConflictResponse, ConflictListResponse } from '../../dto/response/conflict.response.js';

export const ConflictResponseMapper = {
  toResponse(row: SyncConflictRow): ConflictResponse {
    return {
      mutation_id: row.mutationId,
      entity_type: row.entityType,
      entity_guuid: row.entityGuuid,
      conflict_type: row.conflictType,
      server_row: row.serverRow,
      client_payload: row.clientPayload,
      message: row.message,
      status: row.status,
      note: row.note,
      created_at: row.createdAt.toISOString(),
      resolved_at: row.resolvedAt?.toISOString() ?? null,
    };
  },

  toListResponse(rows: SyncConflictRow[]): ConflictListResponse {
    return { conflicts: rows.map((row) => ConflictResponseMapper.toResponse(row)) };
  },
};
