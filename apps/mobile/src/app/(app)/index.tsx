import { useEffect, useMemo } from 'react';
import { Redirect } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { prefetchGlobalLookup, prefetchStates, prefetchCurrencies } from '@ayphen/api-manager';
import { useAuthStore } from '@features/auth/authStore';
import { BootstrapLoader } from '@ui/BootstrapLoader';
import { BUSINESS_CATEGORY_TYPE } from '@features/store/selects/BusinessTypeSelect';

/**
 * Post-login routing gate (mobile-03 §4 step 3-4, §8D.2). Runs every time
 * `(app)` is re-entered (mode chosen, store created/joined) since each of
 * those screens `router.replace('/(app)')`s back here to re-evaluate.
 */
export default function AppGate() {
  const isBootstrapped = useAuthStore((s) => s.isBootstrapped);
  const isLastOpenedResolved = useAuthStore((s) => s.isLastOpenedResolved);
  const lastOpenedStoreId = useAuthStore((s) => s.lastOpenedStoreId);
  const lastAccountMode = useAuthStore((s) => s.lastAccountMode);
  // `snapshot` itself is a stable reference from the store — deriving the
  // array with useMemo (keyed on it) avoids handing Zustand's useSyncExternalStore
  // a freshly-allocated `?? []` on every read, which loops ("getSnapshot should
  // be cached").
  const snapshot = useAuthStore((s) => s.snapshot);
  const storeLocations = useMemo(() => snapshot?.storeLocations ?? [], [snapshot]);
  const storeIds = useMemo(() => storeLocations.map((s) => s.store_id), [storeLocations]);

  const routesToOnboardingHub =
    isBootstrapped &&
    isLastOpenedResolved &&
    !!lastAccountMode &&
    lastAccountMode !== 'personal' &&
    storeIds.length === 0;

  const queryClient = useQueryClient();

  // Warm the create-store wizard's dropdown data the instant we know this
  // login has no store (so it's about to land on the Onboarding Hub) —
  // earlier than the hub screen's own mount, since a Redirect + screen
  // transition still has to happen after this point.
  useEffect(() => {
    if (!routesToOnboardingHub) return;
    void prefetchGlobalLookup(queryClient, BUSINESS_CATEGORY_TYPE);
    void prefetchStates(queryClient);
    void prefetchCurrencies(queryClient);
  }, [routesToOnboardingHub, queryClient]);

  // Bootstrap and the last-opened-store cache both run in the background
  // after launch (AuthProvider) — wait for them before routing, or the
  // mode/store decision would be made on stale (empty) data. On a normal
  // cold launch the native splash already covers this window (_layout.tsx's
  // routingReady waits on both too); this fallback only actually renders on
  // a mid-session re-login, where there's no native splash left to hold.
  if (!isBootstrapped || !isLastOpenedResolved) {
    return <BootstrapLoader />;
  }

  if (!lastAccountMode) return <Redirect href="/(onboarding)/mode-select" />;
  if (lastAccountMode === 'personal') return <Redirect href="/(onboarding)/personal" />;

  if (storeIds.length === 0) {
    // No store access → always the Onboarding Hub, invite or not. It's the
    // single landing for this state — never bypassed straight to invitations
    // or create-store, or an owner who's also invited elsewhere hits a dead
    // end (post-login-onboarding-flow.md §2/§6).
    return <Redirect href="/(onboarding)/onboarding-hub" />;
  }

  const activeStoreId =
    (lastOpenedStoreId && storeIds.includes(lastOpenedStoreId) ? lastOpenedStoreId : null) ??
    (storeIds.length === 1 ? storeIds[0] : null);

  if (!activeStoreId) return <Redirect href="/(app)/store-picker" />;

  return <Redirect href={{ pathname: '/(app)/home', params: { storeId: activeStoreId } }} />;
}
