import { AppState, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager } from '@tanstack/react-query';

let wired = false;

/**
 * Bridge React Query's `focusManager`/`onlineManager` to React Native (§6
 * lifecycle). Both are INERT in RN by default — there is no browser
 * `window` focus/online event — so `refetchOnWindowFocus` and
 * `refetchOnReconnect` never fire, and TanStack queries serve stale cache on
 * app resume / after a reconnect until the next manual action. Wiring them
 * makes management/reference queries (subscription, roles, devices…) revalidate
 * when the app foregrounds or the network returns.
 *
 * Idempotent + registered once from the app root (both `setEventListener`s are
 * global, single-registration APIs).
 */
export function initReactQueryLifecycle(): void {
  if (wired) return;
  wired = true;

  onlineManager.setEventListener((setOnline) =>
    // NetInfo.addEventListener's return value IS the unsubscribe function
    // (unlike AppState's `.remove()`-bearing subscription object) — returning
    // it directly is what TanStack's setEventListener contract expects, and
    // what the sibling focusManager listener below already does correctly.
    NetInfo.addEventListener((state) => {
      setOnline(Boolean(state.isConnected) && state.isInternetReachable !== false);
    }),
  );

  focusManager.setEventListener((handleFocus) => {
    const sub = AppState.addEventListener('change', (status) => {
      if (Platform.OS !== 'web') handleFocus(status === 'active');
    });
    return () => sub.remove();
  });
}