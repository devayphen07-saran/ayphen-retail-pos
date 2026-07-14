import { ScrollView, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  AppLayout,
  Avatar,
  Column,
  LucideIcon,
  Row,
  Typography,
} from '@ayphen/mobile-ui-components';
import { useActiveStoreStore, useActiveStoreContext } from '@store';
import { useAuth } from '@core/providers/AuthProvider';
import { MORE_SECTIONS, type MoreSectionConfig, MenuRowList } from '@features/more';
import { useSyncIssueCount, usePendingSyncCount } from '@features/sync';
import { useNetInfo } from '@react-native-community/netinfo';

/**
 * More tab. Visually modeled on the reference app's MoreScreen (gradient
 * store card + section list + logout row), but only shows data this app
 * actually has today — no role/plan/avatar data exists yet (no subscription
 * state), so those pieces of the reference UI are left out rather than
 * faked. The menu itself has no permission gating (no per-item permission
 * matrix exists yet) — every section is shown. Tapping a section (e.g.
 * "Sales") pushes to MoreSectionScreen, which lists that section's items
 * (e.g. "Refunds & Returns", "Promotions") and handles the actual per-item
 * routing.
 */

export function MoreScreen() {
  const { theme } = useMobileTheme();
  const { logout } = useAuth();
  const store = useActiveStoreContext();
  const clearActiveStore = useActiveStoreStore((s) => s.clearActiveStore);
  const syncIssueCount = useSyncIssueCount();
  const { total: pendingCount } = usePendingSyncCount();
  const net = useNetInfo();
  const isOffline = net.isConnected === false || net.isInternetReachable === false;

  const storeName = store?.name || 'Unknown store';
  // Debug-only tooling (raw SQLite table browser) has no place in a build a
  // store owner or staff member could install — hide it outside dev builds
  // rather than just placing it last.
  const visibleSections = __DEV__ ? MORE_SECTIONS : MORE_SECTIONS.filter((s) => s.key !== 'developer');

  const leaveStore = () => {
    clearActiveStore();
    router.replace('/(app)/store-picker');
  };

  const openSection = (section: MoreSectionConfig) => {
    // Standalone entries (e.g. Subscription) navigate straight to their screen
    // instead of drilling into a sub-menu.
    if (section.route) {
      router.push(section.route);
      return;
    }
    router.push({
      pathname: '/(store)/more-section',
      params: { sectionKey: section.key },
    });
  };

  const handleLogout = () => {
    // Logging out wipes local data (re-login re-syncs from scratch). Offline with
    // unsynced writes = real data loss, so warn hard; online, logout() flushes
    // them first, so a normal confirm is enough.
    const n = pendingCount;
    const plural = n === 1 ? '' : 's';
    if (n > 0 && isOffline) {
      Alert.confirm(
        'Unsynced changes will be lost',
        `You have ${n} change${plural} that haven't synced yet, and you're offline — they can't be saved and will be lost if you log out now.`,
        () => void logout(),
        'Log out anyway',
        'destructive',
      );
      return;
    }
    Alert.confirm(
      'Log out',
      n > 0
        ? `Your ${n} unsynced change${plural} will be synced before you're logged out. You'll need to sign in again to access your stores.`
        : 'You will need to sign in again to access your stores.',
      // logout() → clearSession() now clears the active-store context centrally,
      // so no manual clearActiveStore() here (single source of teardown).
      () => void logout(),
      'Log out',
      'destructive',
    );
  };

  return (
    <AppLayout title="More">
      <Container>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingHorizontal: theme.sizing.medium,
            paddingTop: theme.sizing.small,
            // 40 has no exact token; nearest token is xxLarge (48).
            paddingBottom: theme.sizing.xxLarge,
          }}
        >
          <StoreCardOuter>
            <StoreCardGradient
              colors={theme.gradient.storeCard}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
            >
              <StoreHeaderRow align="center" gap="small">
                <Avatar
                  iconName="Store"
                  size={48}
                  shape="circle"
                  bgColor={theme.overlay.onDark15}
                  iconColor={theme.colorWhite}
                />
                <Column flex={1}>
                  <Typography.Subtitle
                    weight="bold"
                    color={theme.colorWhite}
                    numberOfLines={1}
                  >
                    {storeName}
                  </Typography.Subtitle>
                </Column>
              </StoreHeaderRow>

              <GradientDivider />
              <TouchableOpacity
                onPress={leaveStore}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Switch to a different store"
              >
                <SwitchStoreRow align="center" gap="xSmall">
                  <LucideIcon
                    name="ArrowLeftRight"
                    size={14}
                    color={theme.overlay.onDark55}
                  />
                  <Typography.Caption
                    weight="semiBold"
                    color={theme.colorWhite}
                    style={{ flex: 1 }}
                  >
                    Switch Store
                  </Typography.Caption>
                  <LucideIcon
                    name="ChevronRight"
                    size={14}
                    color={theme.overlay.onDark35}
                  />
                </SwitchStoreRow>
              </TouchableOpacity>
            </StoreCardGradient>
          </StoreCardOuter>

          <MenuRowList
            items={visibleSections.map((section) => ({
              key: section.key,
              title: section.title,
              // Surface "waiting to sync" as a subtitle on the System row —
              // distinct from the badgeCount below, which is for issues (a
              // problem) not normal in-flight work.
              description:
                section.key === 'system' && pendingCount > 0
                  ? `${section.description} · ${pendingCount} waiting to sync`
                  : section.description,
              iconName: section.iconName,
              iconColor: section.iconColor,
              onPress: () => openSection(section),
              badgeCount: section.key === 'system' ? syncIssueCount : undefined,
            }))}
          />

          <LogoutCard>
            <TouchableOpacity
              onPress={handleLogout}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="Log out"
            >
              <LogoutRow align="center" gap="small">
                <LogoutIconContainer $danger>
                  <LucideIcon name="LogOut" size={20} color={theme.colorError} />
                </LogoutIconContainer>
                <Typography.Body
                  weight="semiBold"
                  color={theme.colorError}
                  style={{ flex: 1 }}
                >
                  Log out
                </Typography.Body>
              </LogoutRow>
            </TouchableOpacity>
          </LogoutCard>
        </ScrollView>
      </Container>
    </AppLayout>
  );
}

const Container = styled(View)`
  flex: 1;
  background-color: ${({ theme }) => theme.colorBgLayout};
`;

const StoreCardOuter = styled(View)`
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  overflow: hidden;
  margin-bottom: ${({ theme }) => theme.sizing.small}px;
`;

const StoreCardGradient = styled(LinearGradient)`
  padding: 0;
`;

const GradientDivider = styled(View)`
  height: ${({ theme }) => theme.borderWidth.thin}px;
  background-color: ${({ theme }) => theme.overlay.onDark12};
  margin-left: ${({ theme }) => theme.sizing.medium}px;
  margin-right: ${({ theme }) => theme.sizing.medium}px;
`;

/** Store card header row (avatar + name) — needs asymmetric padding that
 *  Row's symmetric gap/padding props can't express. */
const StoreHeaderRow = styled(Row)`
  padding-horizontal: ${({ theme }) => theme.sizing.medium}px;
  padding-top: ${({ theme }) => theme.sizing.medium}px;
  padding-bottom: ${({ theme }) => theme.sizing.small}px;
`;

/** "Switch Store" touchable row — same asymmetric-padding need as above. */
const SwitchStoreRow = styled(Row)`
  padding-vertical: ${({ theme }) => theme.sizing.small}px;
  padding-horizontal: ${({ theme }) => theme.sizing.medium}px;
`;

/** "Log out" touchable row — same asymmetric-padding need as above. */
const LogoutRow = styled(Row)`
  /* 14 has no exact token; nearest token is small (12). */
  padding-vertical: ${({ theme }) => theme.sizing.small}px;
  padding-horizontal: ${({ theme }) => theme.sizing.medium}px;
`;

/** Icon chip for the logout row — the one row on this screen that isn't
 *  rendered through MenuRowList (it's a one-off, error-colored action).
 *  $danger interpolates the danger background instead of taking it via an
 *  ad-hoc `style` override. */
const LogoutIconContainer = styled(View)<{ $danger?: boolean }>`
  /* 40px is an un-tokenized icon-container size — no matching theme.componentSizing entry. */
  width: 40px;
  height: 40px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme, $danger }) => ($danger ? theme.color.danger.bg : 'transparent')};
`;

const LogoutCard = styled(View)`
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.color.danger.border};
  background-color: ${({ theme }) => theme.colorBgContainer};
  overflow: hidden;
  margin-top: ${({ theme }) => theme.sizing.medium}px;
`;
