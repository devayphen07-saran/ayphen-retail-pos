import { SyncScheduler, type SyncEngineLike } from './sync-scheduler';
import { RateLimitedError } from '../transport/rate-limit-error';

/** Fake engine whose `runSyncCycle` behavior is scripted per-call — lets these
 *  tests drive `SyncScheduler`'s retry logic without touching the real
 *  `SyncEngine` (no DB, no network), matching apply-changes.ts's injection
 *  pattern for the same reason. */
function fakeEngine(runSyncCycleImpl: () => Promise<void>): SyncEngineLike {
  return {
    openStore: jest.fn().mockResolvedValue(undefined),
    runPush: jest.fn().mockResolvedValue(undefined),
    runSyncCycle: jest.fn().mockImplementation(runSyncCycleImpl),
  };
}

describe('SyncScheduler — rate-limit retry scheduling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries at the server-specified delay instead of waiting the full heartbeat interval', async () => {
    let calls = 0;
    const engine = fakeEngine(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new RateLimitedError(5_000)) : Promise.resolve();
    });
    const scheduler = new SyncScheduler('store-1', engine);

    await scheduler.onNetworkRestored();
    expect(calls).toBe(1);

    // Not yet — the retry is scheduled for 5s out, not immediate.
    await jest.advanceTimersByTimeAsync(4_000);
    expect(calls).toBe(1);

    // Past the 5s mark — the retry should have fired on its own, with no
    // further caller action (this is what makes it better than the flat
    // 5-minute heartbeat: the app didn't have to wait for the next tick).
    await jest.advanceTimersByTimeAsync(1_500);
    expect(calls).toBe(2);

    scheduler.stop();
  });

  it('gives up after MAX_CONSECUTIVE_RATE_LIMIT_RETRIES and stops scheduling immediate retries', async () => {
    let calls = 0;
    const engine = fakeEngine(() => {
      calls += 1;
      return Promise.reject(new RateLimitedError(100)); // always rate-limited
    });
    const scheduler = new SyncScheduler('store-1', engine);

    await scheduler.onNetworkRestored(); // attempt 1
    for (let i = 0; i < 5; i++) {
      await jest.advanceTimersByTimeAsync(200);
    }

    // 1 initial attempt + 3 retries (MAX_CONSECUTIVE_RATE_LIMIT_RETRIES) = 4,
    // then it gives up rather than looping forever against a persistent block.
    expect(calls).toBe(4);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(4); // no further attempts — confirmed it actually stopped, not just slowed

    scheduler.stop();
  });

  it('a non-429 outcome resets the consecutive-retry counter', async () => {
    let calls = 0;
    const engine = fakeEngine(() => {
      calls += 1;
      if (calls <= 2) return Promise.reject(new RateLimitedError(100));
      if (calls === 3) return Promise.reject(new Error('offline')); // unrelated failure — resets the counter
      return Promise.reject(new RateLimitedError(100));
    });
    const scheduler = new SyncScheduler('store-1', engine);

    await scheduler.onNetworkRestored(); // call 1: RateLimitedError
    await jest.advanceTimersByTimeAsync(200); // call 2: RateLimitedError
    await jest.advanceTimersByTimeAsync(200); // call 3: plain Error — counter resets, no retry scheduled from this branch
    expect(calls).toBe(3);

    // Since call 3 wasn't a RateLimitedError, no retry timer was scheduled —
    // advancing time further must NOT produce a call 4 on its own.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(3);

    scheduler.stop();
  });

  it('stop() clears a pending retry timer so it never fires against a stopped scheduler', async () => {
    let calls = 0;
    const engine = fakeEngine(() => {
      calls += 1;
      return Promise.reject(new RateLimitedError(5_000));
    });
    const scheduler = new SyncScheduler('store-1', engine);

    await scheduler.onNetworkRestored();
    expect(calls).toBe(1);

    scheduler.stop(); // must clear the pending 5s retry timer, not just ignore it

    await jest.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1); // no further call — the timer was actually cleared
  });
});
