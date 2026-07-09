import { useAuthStore } from '@store';
import { getSyncDb, runMigrations } from '../db/client';
import { syncCursorRepository } from '../repositories/sync-cursor.repository';
import { mutationQueueRepository } from '../repositories/mutation-queue.repository';
import { syncStoreMetaRepository } from '../repositories/sync-store-meta.repository';
import { runColdStart } from './cold-start';
import { rebaseOnPermissionGrant } from './permission-rebase';
import { pullDeltaToCompletion } from './delta-pull';
import { drainMutationQueueOnce } from './drain-queue';

/**
 * SyncEngine — the MECHANISM (mobile-11 §2): given a store, know how to open
 * it (cold start if needed, else steady-state) and how to run one push/pull
 * cycle. Bound to one `storeId` at a time; switching stores rebinds it.
 *
 * Deliberately NOT responsible for WHEN to run — that's SyncScheduler. Keeping
 * battery/network/foreground policy out of this class means the durable
 * write path (queue, cursor, appliers) never depends on scheduling decisions.
 */
export class SyncEngine {
  constructor(private readonly storeId: string) {}

  /**
   * Migrate-before-sync (INV-5) lives HERE, not in app boot — self-contained
   * so opening a store is correct regardless of what else has or hasn't run
   * yet at launch. `runMigrations()` is idempotent (drizzle's migrator tracks
   * applied migrations), so paying its cost on every store open is cheap.
   * Cold start only runs once per store — its own cursor's presence is the
   * "already done" marker; a store with a cursor gets steady-state pull only.
   */
  async openStore(): Promise<void> {
    await runMigrations();
    const db = getSyncDb();
    // Crash recovery (INV-10): a hard app-kill between `markInflight` and
    // reconcile leaves rows orphaned in 'inflight', which `takeDrainable` never
    // re-selects. Reset them to 'pending' on open — this runs inside the
    // scheduler's exclusive guard, so no push is genuinely in flight — so the
    // next drain resubmits them instead of losing the writes.
    await mutationQueueRepository.resetOrphanedInflight(db, this.storeId);

    // Permission-grant backfill (S-5) + revoke purge: if this user's
    // permissions_version grew since we last synced this store, an entity that
    // was withheld at cold start would never delta-backfill — so drop the
    // cursor + progress here and let the cold start below re-dump everything
    // under the new permission set; a REVOKED `view` grant additionally purges
    // that entity's cached rows (see permission-rebase.ts). Read the snapshot
    // as getState() (not a hook) — this is non-React mechanism code, same
    // access pattern as the network interceptors.
    const snapshot = useAuthStore.getState().snapshot;
    const currentPermissionsVersion = snapshot?.permissionsVersion ?? null;
    const currentPermissions =
      snapshot?.stores.find((s) => s.store_id === this.storeId)?.permissions ?? null;
    await rebaseOnPermissionGrant(db, this.storeId, currentPermissionsVersion, currentPermissions);

    const cursor = await syncCursorRepository.get(db, this.storeId);
    if (!cursor) {
      await runColdStart(db, this.storeId);
    }

    // Stamp the version + permission set we've now synced this store under, so
    // the next open can detect a future grant/revoke. Runs after cold start so
    // a fresh store is recorded too. Skipped when the snapshot isn't loaded
    // yet (nothing to compare later).
    if (currentPermissionsVersion != null) {
      await syncStoreMetaRepository.setPermissionsVersion(
        db,
        this.storeId,
        currentPermissionsVersion,
        currentPermissions ?? [],
        new Date().toISOString(),
      );
    }
  }

  /** Push-before-pull, always (mobile-11 §10) — pulling first would clobber
   *  local edits or manufacture needless conflicts against them. */
  async runSyncCycle(): Promise<void> {
    const db = getSyncDb();
    await this.drainQueueFully(db);
    await pullDeltaToCompletion(db, this.storeId);
  }

  /** Push only — the background-window behavior (mobile-11 §10): flush the
   *  queue, don't poll for new data. */
  async runPush(): Promise<void> {
    await this.drainQueueFully(getSyncDb());
  }

  async runPull(): Promise<void> {
    await pullDeltaToCompletion(getSyncDb(), this.storeId);
  }

  // Ceiling on how many 100-row batches one drainQueueFully() call processes.
  // Without it, a backlog built up over an extended offline period drains in
  // one continuous, unbroken run right at reconnect — exactly when the user
  // is back and interacting. Capping here lets a run return early; the next
  // scheduler tick (or reconnect) resumes where this one left off.
  private static readonly MAX_BATCHES_PER_CYCLE = 20;

  private async drainQueueFully(db: ReturnType<typeof getSyncDb>): Promise<void> {
    let drained = true;
    let batches = 0;
    while (drained && batches < SyncEngine.MAX_BATCHES_PER_CYCLE) {
      const result = await drainMutationQueueOnce(db, this.storeId);
      drained = result.drained > 0;
      batches++;
    }
  }
}
