import type { SyncDeltaResponse, MutationResultWire } from '../../dto/response/delta.response.js';

/** Domain result computed by SyncDeltaService.buildResult() — camelCase, pre-wire. */
export interface SyncDeltaDomainResult {
  mutationResults: MutationResultWire[];
  changes: SyncDeltaResponse['changes'];
  syncCursor: string | null;
  hasMore: boolean;
  serverTime: string;
  permissionsVersion: number;
  snapshot?: { snapshot: unknown; signature: string };
}

export const DeltaResponseMapper = {
  toResponse(r: SyncDeltaDomainResult): SyncDeltaResponse {
    return {
      mutation_results: r.mutationResults,
      changes: r.changes,
      sync_cursor: r.syncCursor,
      has_more: r.hasMore,
      server_time: r.serverTime,
      permissions_version: r.permissionsVersion,
      ...(r.snapshot
        ? { snapshot: r.snapshot.snapshot, snapshot_signature: r.snapshot.signature }
        : {}),
    };
  },
};
