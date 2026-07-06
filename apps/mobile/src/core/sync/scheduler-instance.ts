import NetInfo from '@react-native-community/netinfo';
import { AppState, type AppStateStatus } from 'react-native';
import { SyncScheduler } from './engine/sync-scheduler';
import { useStoreOpenStatus } from './store-open-status';

/** Foreground heartbeat cadence — steady-state polling while the app is open
 *  and a store is active. Not aggressive: most freshness comes from the
 *  push-then-pull that happens on every mutation drain, not this timer. */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

let current: { storeId: string; scheduler: SyncScheduler } | null = null;

/**
 * Start (or rebind) the sync scheduler for a store. Idempotent for the same
 * store — calling this again while already bound to `storeId` is a no-op,
 * so effect re-runs / duplicate calls from re-navigation are harmless.
 *
 * `current` is only assigned AFTER the initial open succeeds (navigation-agent
 * §4/golden rule 8 — the store-open state machine). On failure, `current`
 * stays whatever `stopSync()` left it as (null), so a later retry call to
 * this same function re-enters fully rather than short-circuiting on the
 * `current?.storeId === storeId` guard above.
 */
export async function startSyncForStore(storeId: string): Promise<void> {
  if (current?.storeId === storeId) return;
  stopSync();
  useStoreOpenStatus.getState().setOpening(storeId);

  const scheduler = new SyncScheduler(storeId);
  try {
    await scheduler.openStoreOnce();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not open this store.';
    useStoreOpenStatus.getState().setError(storeId, message);
    return;
  }

  current = { storeId, scheduler };
  useStoreOpenStatus.getState().setReady(storeId);
  // `start()`'s own internal open call is now a no-op (cursor already set by
  // openStoreOnce above) — this just begins the periodic heartbeat.
  void scheduler.start(SYNC_INTERVAL_MS);
}

export function stopSync(): void {
  current?.scheduler.stop();
  current = null;
  useStoreOpenStatus.getState().reset();
}

let listenersStarted = false;
let wasConnected = true;
let appState: AppStateStatus = AppState.currentState;

/**
 * Reconnect/background triggers (mobile-11 §10) — registered ONCE, globally,
 * not per-store. Both handlers read the live `current` module variable at
 * fire time rather than closing over a specific scheduler instance, so a
 * store switch never needs matching subscribe/unsubscribe calls here:
 * `startSyncForStore`/`stopSync` only ever swap `current`, they never touch
 * these listeners.
 */
export function initSyncListeners(): void {
  if (listenersStarted) return;
  listenersStarted = true;

  NetInfo.addEventListener((state) => {
    const isConnected = Boolean(state.isConnected) && state.isInternetReachable !== false;
    if (isConnected && !wasConnected) {
      void current?.scheduler.onNetworkRestored();
    }
    wasConnected = isConnected;
  });

  AppState.addEventListener('change', (next) => {
    if (next === 'active' && appState !== 'active') {
      void current?.scheduler.onNetworkRestored();
    } else if (next === 'background') {
      void current?.scheduler.onBackground();
    }
    appState = next;
  });
}

/** Fire a push+pull cycle immediately (e.g. right after enqueueing a local
 *  write) instead of waiting for the next heartbeat tick — best-effort, UI
 *  should never depend on this succeeding since the periodic tick is the
 *  durable fallback. */
export function requestImmediateSync(): void {
  void current?.scheduler.onNetworkRestored();
}
