import { getSyncDb, runMigrations } from '../db/client';
import { syncCursorRepository } from '../repositories/sync-cursor.repository';
import { runColdStart } from './cold-start';
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
    const cursor = await syncCursorRepository.get(db, this.storeId);
    if (!cursor) {
      await runColdStart(db, this.storeId);
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

  private async drainQueueFully(db: ReturnType<typeof getSyncDb>): Promise<void> {
    let drained = true;
    while (drained) {
      const result = await drainMutationQueueOnce(db, this.storeId);
      drained = result.drained > 0;
    }
  }
}
