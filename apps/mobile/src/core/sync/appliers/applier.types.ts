import type { SyncDb } from '../db/types';
import type { WireRow } from '../repositories/synced-table.repository';

/**
 * One entity's local apply implementation — mirrors the server's
 * `SyncEntityFilter`/`MutationHandlerRegistry` pairing (registration, not a
 * switch statement). Used identically by cold start, delta pull, and the
 * delta page piggybacked on a mutation push response.
 */
export interface SyncApplier {
  entityType: string;
  upsertAll(db: SyncDb, storeId: string, rows: WireRow[]): Promise<void>;
  applyDeletes(db: SyncDb, guuids: string[]): Promise<void>;
}
