import type { SnapshotResult } from '#common/types/permission-snapshot.js';

/**
 * Envelope fields SnapshotRefreshInterceptor appends to every authenticated
 * response body. Pure function — no DI, no side effects — so the interceptor
 * itself never hand-builds the snake_case wire keys (layered-architecture §3.7).
 */
export interface SnapshotEnvelope {
  snapshot?: SnapshotResult['snapshot'];
  snapshot_signature?: string;
  snapshot_changed: boolean;
}

export const SnapshotEnvelopeMapper = {
  toEnvelope(snapshotResult: SnapshotResult | null): SnapshotEnvelope {
    if (!snapshotResult) return { snapshot_changed: false };
    return {
      snapshot: snapshotResult.snapshot,
      snapshot_signature: snapshotResult.signature,
      snapshot_changed: true,
    };
  },
};