import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { AppLayout, Column, LucideIcon, Row, Typography, OverlayLoader } from '@ayphen/mobile-ui-components';
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
      <ScrollView contentContainerStyle={{ padding: theme.sizing.large, flexGrow: 1 }}>
        <Typography.Caption type="secondary" style={{ marginBottom: theme.sizing.medium }}>
          Select a store to continue.
        </Typography.Caption>
        <Column gap={10}>
          {stores.map((store) => {
            return (
              <StoreCard key={store.store_id} onPress={() => openStore(store)} activeOpacity={0.7}>
                <Row align="center" gap={12}>
                  <IconSlot>
                    <LucideIcon name="Store" size={20} color={theme.color.primary.main} />
                  </IconSlot>
                  <Column flex={1} gap={4}>
                    <Typography.Body weight="semiBold" numberOfLines={1}>
                      {store.name || 'Unnamed store'}
                    </Typography.Body>
                  </Column>
                  <ChevronSlot>
                    <LucideIcon name="ChevronRight" size={16} color={theme.colorTextTertiary} />
                  </ChevronSlot>
                </Row>
              </StoreCard>
            );
          })}
        </Column>
      </ScrollView>
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

const StoreCard = styled.TouchableOpacity`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  padding: ${({ theme }) => theme.sizing.medium}px;
  ${({ theme }) => theme.shadow.sm}
`;

const IconSlot = styled(View)`
  width: 44px;
  height: 44px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme }) => theme.color.primary.bg};
`;

const ChevronSlot = styled(View)`
  width: 28px;
  height: 28px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme }) => theme.colorFillSecondary ?? theme.colorBgLayout};
`;