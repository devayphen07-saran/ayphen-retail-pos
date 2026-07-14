import NetInfo, {
  type NetInfoSubscription,
} from '@react-native-community/netinfo';
import {
  AppState,
  type AppStateStatus,
  type NativeEventSubscription,
} from 'react-native';
import { SyncScheduler } from './engine/sync-scheduler';
import { useStoreOpenStatus } from './store-open-status';
import { ImageUploader } from './image-uploader';
import {
  setImageUploader,
  requestImageUpload,
} from './image-uploader-instance';

/**
 * Foreground heartbeat cadence while the app is open and a store is active.
 * Most freshness still comes from mutation-triggered push/pull cycles.
 */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

type CurrentSync = {
  storeId: string;
  scheduler: SyncScheduler;
  generation: number;
};

let current: CurrentSync | null = null;
let opening: {
  storeId: string;
  generation: number;
  scheduler: SyncScheduler;
} | null = null;

let generation = 0;

let listenersStarted = false;
let netInfoUnsubscribe: NetInfoSubscription | null = null;
let appStateSubscription: NativeEventSubscription | null = null;

let wasConnected = true;
let appState: AppStateStatus = AppState.currentState;

function isStillOpening(storeId: string, startedGeneration: number): boolean {
  return (
    opening?.storeId === storeId &&
    opening.generation === startedGeneration &&
    generation === startedGeneration
  );
}

function isCurrent(storeId: string, startedGeneration: number): boolean {
  return (
    current?.storeId === storeId &&
    current.generation === startedGeneration &&
    generation === startedGeneration
  );
}

function stopScheduler(scheduler: SyncScheduler | undefined): void {
  try {
    scheduler?.stop();
  } catch {
    // Best effort. Stop must not block rebinding to another store.
  }
}

/**
 * Start or rebind sync for a store.
 *
 * Idempotent for the same active/opening store. Uses a generation token so a
 * slow previous open cannot become current after the user switches stores or
 * logs out.
 */
export async function startSyncForStore(storeId: string): Promise<void> {
  if (current?.storeId === storeId) return;
  if (opening?.storeId === storeId) return;

  stopSync();

  const startedGeneration = generation + 1;
  generation = startedGeneration;

  const scheduler = new SyncScheduler(storeId);
  opening = {
    storeId,
    generation: startedGeneration,
    scheduler,
  };

  useStoreOpenStatus.getState().setOpening(storeId);

  try {
    await scheduler.openStoreOnce();
  } catch (err) {
    if (!isStillOpening(storeId, startedGeneration)) {
      stopScheduler(scheduler);
      return;
    }

    opening = null;

    const message =
      err instanceof Error ? err.message : 'Could not open this store.';

    useStoreOpenStatus.getState().setError(storeId, message);
    stopScheduler(scheduler);
    return;
  }

  if (!isStillOpening(storeId, startedGeneration)) {
    stopScheduler(scheduler);
    return;
  }

  opening = null;
  current = {
    storeId,
    scheduler,
    generation: startedGeneration,
  };

  setImageUploader(new ImageUploader(storeId));
  requestImageUpload();

  useStoreOpenStatus.getState().setReady(storeId);

  void scheduler.start(SYNC_INTERVAL_MS).catch((err) => {
    if (!isCurrent(storeId, startedGeneration)) return;

    const message =
      err instanceof Error ? err.message : 'Store sync failed to start.';

    useStoreOpenStatus.getState().setError(storeId, message);
  });
}

export function stopSync(): void {
  generation += 1;

  stopScheduler(opening?.scheduler);
  stopScheduler(current?.scheduler);

  opening = null;
  current = null;

  setImageUploader(null);
  useStoreOpenStatus.getState().reset();
}

/**
 * Recover a store whose initial open failed.
 *
 * Reconnect/foreground handlers can resume only a bound scheduler. If the
 * initial open failed, no scheduler is bound, so retry the open from the store
 * recorded in the store-open status.
 */
function retryStrandedStoreOpen(): void {
  if (current || opening) return;

  const { storeId, phase } = useStoreOpenStatus.getState();

  if (storeId && phase === 'error') {
    void startSyncForStore(storeId);
  }
}

function handleReconnectOrForeground(): void {
  retryStrandedStoreOpen();
  // Wake the uploader now AND once the reconnect sync lands (same rationale as
  // requestImmediateSync): the immediate wake races ahead of the queued creates
  // being pushed/applied, so a record created offline would have its image stay
  // deferred until some later unrelated wake without the post-cycle re-wake.
  void current?.scheduler.onNetworkRestored().then(() => requestImageUpload());
  requestImageUpload();
}

/**
 * Reconnect/background triggers.
 *
 * Registered once globally. Handlers read the live module-level `current`
 * reference, so switching stores does not require per-store listener churn.
 */
export function initSyncListeners(): void {
  if (listenersStarted) return;

  listenersStarted = true;

  netInfoUnsubscribe = NetInfo.addEventListener((state) => {
    const isConnected =
      Boolean(state.isConnected) && state.isInternetReachable !== false;

    if (isConnected && !wasConnected) {
      handleReconnectOrForeground();
    }

    wasConnected = isConnected;
  });

  appStateSubscription = AppState.addEventListener('change', (next) => {
    if (next === 'active' && appState !== 'active') {
      handleReconnectOrForeground();
    } else if (next === 'background') {
      void current?.scheduler.onBackground();
    }

    appState = next;
  });
}

/**
 * Optional test/dev cleanup for the global listeners. Normal app runtime should
 * call `initSyncListeners` once and leave them installed.
 */
export function disposeSyncListeners(): void {
  netInfoUnsubscribe?.();
  appStateSubscription?.remove();

  netInfoUnsubscribe = null;
  appStateSubscription = null;
  listenersStarted = false;
}

/**
 * Fire a push+pull cycle immediately, e.g. right after enqueueing a local write.
 * Best effort: most callers should not depend on this succeeding because the
 * periodic heartbeat remains the durable fallback — `runExclusive` inside the
 * scheduler already catches and logs any cycle failure, so the promise this
 * returns resolves even when the cycle itself failed. It's still returned
 * (rather than fire-and-forget `void`) so a manual "sync now" UI affordance
 * (e.g. SyncStatusIcon) can await it purely to know when to stop showing its
 * own in-progress state.
 */
export function requestImmediateSync(): Promise<void> {
  // Wake the image uploader BOTH now and again once the sync cycle finishes.
  // The immediate wake covers images whose parent was already synced; the
  // post-cycle wake is what lets a just-created record's image commit promptly:
  // enqueueing a create + calling this fires the push and this wake concurrently,
  // so the first wake races AHEAD of the create being marked `applied` and the
  // uploader defers — without re-waking after the push lands, the image would
  // sit deferred until the next unrelated wake (foreground / next mutation).
  // Optional chaining short-circuits the whole chain when no store is bound.
  const cycle = (current?.scheduler.onNetworkRestored() ?? Promise.resolve()).then(() => {
    requestImageUpload();
  });
  requestImageUpload();
  return cycle;
}
