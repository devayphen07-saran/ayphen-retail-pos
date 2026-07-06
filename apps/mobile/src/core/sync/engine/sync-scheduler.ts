// Type-only import — erased at compile time, so it does NOT pull in the real
// `SyncEngine` module (and transitively `db/client.ts` → `expo-sqlite`, an
// ESM-only native module Jest can't parse) just from importing this file.
// The concrete class is required lazily in the constructor instead, only on
// the path that actually needs it — same reason `db/transaction.test.ts` uses
// `create-test-db.ts` (better-sqlite3) rather than ever importing the real
// `db/client.ts`.
import type { SyncEngine } from './sync-engine';
import { RateLimitedError } from '../transport/rate-limit-error';
import { logger } from '../../../utils/logger';

/** Consecutive 429s before giving up on immediate retry and falling back to
 *  the normal heartbeat interval — guards against a retry storm if the
 *  server stays saturated (or `Retry-After` is small) across attempts. */
const MAX_CONSECUTIVE_RATE_LIMIT_RETRIES = 3;

/** Upper bound on how long a single rate-limit retry ever waits, regardless
 *  of what the server's `Retry-After` says — a misbehaving/huge header value
 *  shouldn't make the app wait unreasonably long before trying again. */
const MAX_RATE_LIMIT_RETRY_DELAY_MS = 2 * 60_000;

/** Just what the scheduler needs from an engine — lets tests inject a fake
 *  (e.g. one whose `runSyncCycle` rejects with `RateLimitedError`) without
 *  mocking the real `SyncEngine` (same pattern as apply-changes.ts's
 *  `ApplierLookup` injection). */
export interface SyncEngineLike {
  openStore(): Promise<void>;
  runSyncCycle(): Promise<void>;
  runPush(): Promise<void>;
}

/**
 * SyncScheduler — the POLICY (mobile-11 §2): decides WHEN to call
 * `SyncEngine.runSyncCycle()`/`runPush()`. It never touches the queue or
 * cursors directly — only ever calls the engine's public methods — so
 * battery/network rules can change without touching the durable write path.
 *
 * Real triggers (AppState foreground/background, NetInfo reconnect) are wired
 * via `scheduler-instance.ts`'s `initSyncListeners()`, called once from the
 * app root. This class only owns the timer/manual-trigger mechanics so those
 * triggers have something concrete to call into.
 */
export class SyncScheduler {
  private readonly engine: SyncEngineLike;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private consecutiveRateLimits = 0;

  constructor(private readonly storeId: string, engine?: SyncEngineLike) {
    if (engine) {
      this.engine = engine;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { SyncEngine: ConcreteSyncEngine } = require('./sync-engine') as { SyncEngine: typeof SyncEngine };
      this.engine = new ConcreteSyncEngine(storeId);
    }
  }

  /**
   * Migrate + cold-start (if needed), UNWRAPPED — errors propagate to the
   * caller instead of being swallowed by `runExclusive`. `start()`'s own
   * internal open (below) intentionally swallows failures because the
   * periodic timer is its own durable retry; but the store-open readiness
   * gate (`store-open-status.ts`) needs the real success/failure signal the
   * FIRST time a store opens — otherwise a failed cold start would silently
   * report "ready" and let the navigator mount over a store with no local
   * data (navigation-agent.md §4/golden rule 8).
   */
  async openStoreOnce(): Promise<void> {
    await this.engine.openStore();
  }

  /** Cold-start-if-needed, then start the periodic foreground heartbeat. */
  async start(intervalMs: number): Promise<void> {
    await this.runExclusive(() => this.engine.openStore());
    this.tick(); // don't wait a full interval for the first cycle
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.consecutiveRateLimits = 0;
  }

  /** Reconnect handler: push-before-pull is already runSyncCycle's order. */
  async onNetworkRestored(): Promise<void> {
    await this.tick();
  }

  /**
   * Background-window handler: flush the queue, don't poll for new data.
   * Goes through the SAME `running` guard as `tick()` — without this, a
   * background event mid-cycle would call `runPush()` while a foreground
   * `runSyncCycle()` is still mid-drain, and two concurrent drains can both
   * read the same 'pending' rows before either marks them 'inflight',
   * double-submitting the same mutations to the server.
   */
  async onBackground(): Promise<void> {
    await this.runExclusive(() => this.engine.runPush());
  }

  private async tick(): Promise<void> {
    await this.runExclusive(async () => {
      // Idempotent — a no-op past the first successful cold start (openStore
      // only runs it when no local cursor exists yet). Calling it again here
      // means a cold start that failed on a PRIOR tick (offline, backend
      // error) retries automatically on the next one, instead of being stuck
      // forever — runSyncCycle alone throws "cold start must run first" with
      // no cursor, and nothing else in this class ever re-attempts openStore.
      await this.engine.openStore();
      await this.engine.runSyncCycle();
    });
  }

  private async runExclusive(fn: () => Promise<void>): Promise<void> {
    if (this.running) return; // don't overlap two cycles on a slow network
    this.running = true;
    try {
      await fn();
      this.consecutiveRateLimits = 0;
    } catch (err) {
      if (err instanceof RateLimitedError) {
        this.scheduleRateLimitRetry(err);
      } else {
        this.consecutiveRateLimits = 0;
        // Every entry point here runs unawaited from its caller (the interval
        // timer; scheduler-instance.ts's `void startSyncForStore(...)`) — an
        // uncaught rejection here has no catch to land in and crashes the app
        // (exactly the "Uncaught (in promise, id: 0) AxiosError" case: a 403/5xx
        // or offline network error propagating out of a pull/push call with no
        // try/catch anywhere in engine/*). Log and swallow instead — the next
        // timer tick or reconnect is the durable retry this was designed around
        // (see requestImmediateSync's own "UI should never depend on this
        // succeeding" comment); there is no caller here to hand the error to.
        logger.error(`[sync] cycle failed for store ${this.storeId}`, err);
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * A 429 means "stop hammering the server," not "something is broken" — log
   * at `warn`, not `error`, and use the server's own `Retry-After` instead of
   * waiting out the full heartbeat interval blind. Capped both in delay
   * (`MAX_RATE_LIMIT_RETRY_DELAY_MS`, in case of a huge/misbehaving header)
   * and in consecutive attempts (`MAX_CONSECUTIVE_RATE_LIMIT_RETRIES`, in case
   * the server stays saturated on every retry — falls back to the normal
   * interval rather than looping tight retries against a persistent block).
   */
  private scheduleRateLimitRetry(err: RateLimitedError): void {
    this.consecutiveRateLimits += 1;
    if (this.consecutiveRateLimits > MAX_CONSECUTIVE_RATE_LIMIT_RETRIES) {
      logger.warn(
        `[sync] rate limited ${this.consecutiveRateLimits} times in a row for store ${this.storeId} — ` +
          `giving up on immediate retry, resuming on the next heartbeat`,
      );
      return;
    }

    const delayMs = Math.min(err.retryAfterMs, MAX_RATE_LIMIT_RETRY_DELAY_MS);
    logger.warn(
      `[sync] rate limited for store ${this.storeId} — retrying in ${delayMs}ms ` +
        `(attempt ${this.consecutiveRateLimits}/${MAX_CONSECUTIVE_RATE_LIMIT_RETRIES})`,
    );

    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.tick();
    }, delayMs);
  }
}
