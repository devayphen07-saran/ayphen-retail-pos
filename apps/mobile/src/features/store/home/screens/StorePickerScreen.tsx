import { useMemo } from 'react';
import { ScrollView } from 'react-native';
import { Redirect } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  AppLayout,
  Avatar,
  Card,
  Column,
  LucideIcon,
  Row,
  Typography,
  OverlayLoader,
} from '@ayphen/mobile-ui-components';
import { useAuthStore, type StoreContext } from '@store';
import { setLastOpenedStoreId } from '../../shared/utils/prefs';
import { useEnterStore } from '../../shared/hooks/useEnterStore';

/**
 * More than one accessible store and no remembered "last opened" — ask which
 * one to open (mobile-03 §4: "no pointer & >1 store → STORE PICKER, don't
 * auto-pick stores[0]").
 *
 * The snapshot's `stores` entries carry the store `name`
 * (auth/types.ts PermissionSnapshot), so each row shows the store name —
 * never the raw store id.
 */
export function StorePickerScreen() {
  const { theme } = useMobileTheme();
  const snapshot = useAuthStore((s) => s.snapshot);
  const { enterStore, checking, cancelChecking } = useEnterStore();
  const stores = useMemo(() => snapshot?.stores ?? [], [snapshot]);

  // Defense-in-depth: AppGate only routes here when there's >1 store to choose
  // from, but a snapshot that empties while mounted (e.g. a server-side flush,
  // or a fresh-login snapshot replacing a stale persisted one) would otherwise
  // strand the user on an empty picker with no CTA. Bounce back to the gate so
  // it re-routes to onboarding instead of showing a dead end.
  if (stores.length === 0) return <Redirect href="/(app)" />;

  const openStore = async (store: StoreContext) => {
    // A tap fires a network device-slot claim (below). Ignore further taps
    // while one is in flight so the user can't kick off two claims — the
    // OverlayLoader also blocks the UI to make the wait visible.
    if (checking) return;
    await setLastOpenedStoreId(store.store_id);
    // Claims (or is refused, e.g. device_limit_reached) this device's slot
    // BEFORE entering the store — being in the account's store list doesn't
    // mean this device has a slot (device-management §7 F2).
    await enterStore(store);
  };

  return (
    <AppLayout title="Choose a store">
      <PickerScroll>
        <SelectHint type="secondary">
          Select a store to continue.
        </SelectHint>

        <Column gap={theme.sizing.small}>
          {stores.map((store) => {
            const name = store.name || 'Unnamed store';
            const initials = name.trim().slice(0, 2).toUpperCase() || '?';
            return (
              <Card
                key={store.store_id}
                onPress={() => openStore(store)}
                shadow
                bordered={false}
                padding="none"
              >
                <Row align="center" gap="small" padding="medium">
                  <Avatar initials={initials} size={44} shape="square" />
                  <Column flex={1} gap={2}>
                    <Typography.Body weight="semiBold" numberOfLines={1}>
                      {name}
                    </Typography.Body>
                    <Typography.Caption type="secondary" numberOfLines={1}>
                      Tap to open
                    </Typography.Caption>
                  </Column>
                  <LucideIcon
                    name="ChevronRight"
                    size={20}
                    color={theme.colorTextTertiary}
                  />
                </Row>
              </Card>
            );
          })}
        </Column>
      </PickerScroll>
      {/* The slot claim is a network round-trip with no other on-screen
          feedback — block the UI so the tap doesn't read as a no-op and the
          store can't be double-entered (loading-agent.md §3). If the call
          hangs, `timeoutMs` + `onCancel` give an actual way out instead of
          trapping the user behind the overlay indefinitely. */}
      <OverlayLoader
        visible={checking}
        message="Opening store…"
        timeoutMs={12_000}
        onCancel={cancelChecking}
      />
    </AppLayout>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const PickerScroll = styled(ScrollView).attrs(({ theme }) => ({
  contentContainerStyle: {
    paddingHorizontal: theme.sizing.large,
    paddingTop: theme.sizing.medium,
    paddingBottom: theme.sizing.large,
  },
}))``;

const SelectHint = styled(Typography.Caption)`
  margin-bottom: ${({ theme }) => theme.sizing.medium}px;
`;