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
import { useActiveStoreStore } from '@store';
import { useAuth } from '@core/providers/AuthProvider';
import { MORE_SECTIONS, type MoreSectionConfig, MenuRowList } from '@features/more';

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
  const store = useActiveStoreStore((s) => s.store);
  const clearActiveStore = useActiveStoreStore((s) => s.clearActiveStore);

  const storeName = store?.name || 'Unknown store';

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
    Alert.confirm(
      'Log out',
      'You will need to sign in again to access your stores.',
      () => {
        clearActiveStore();
        void logout();
      },
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
            paddingBottom: 40,
          }}
        >
          <StoreCardOuter>
            <StoreCardGradient
              colors={theme.gradient.storeCard}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
            >
              <Row
                align="center"
                gap="small"
                style={{
                  paddingHorizontal: theme.sizing.medium,
                  paddingTop: theme.sizing.medium,
                  paddingBottom: theme.sizing.small,
                }}
              >
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
              </Row>

              <GradientDivider />
              <TouchableOpacity
                onPress={leaveStore}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Switch to a different store"
              >
                <Row
                  align="center"
                  gap="xSmall"
                  style={{
                    paddingVertical: theme.sizing.small,
                    paddingHorizontal: theme.sizing.medium,
                  }}
                >
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
                </Row>
              </TouchableOpacity>
            </StoreCardGradient>
          </StoreCardOuter>

          <MenuRowList
            items={MORE_SECTIONS.map((section) => ({
              key: section.key,
              title: section.title,
              description: section.description,
              iconName: section.iconName,
              iconColor: section.iconColor,
              onPress: () => openSection(section),
            }))}
          />

          <LogoutCard>
            <TouchableOpacity
              onPress={handleLogout}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="Log out"
            >
              <Row
                align="center"
                gap="small"
                style={{
                  paddingVertical: 14,
                  paddingHorizontal: theme.sizing.medium,
                }}
              >
                <LogoutIconContainer
                  style={{ backgroundColor: theme.color.danger.bg }}
                >
                  <LucideIcon name="LogOut" size={20} color={theme.colorError} />
                </LogoutIconContainer>
                <Typography.Body
                  weight="semiBold"
                  color={theme.colorError}
                  style={{ flex: 1 }}
                >
                  Log out
                </Typography.Body>
              </Row>
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

/** Icon chip for the logout row — the one row on this screen that isn't
 *  rendered through MenuRowList (it's a one-off, error-colored action). */
const LogoutIconContainer = styled(View)`
  width: 40px;
  height: 40px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  align-items: center;
  justify-content: center;
`;

const LogoutCard = styled(View)`
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.color.danger.border};
  background-color: ${({ theme }) => theme.colorBgContainer};
  overflow: hidden;
  margin-top: ${({ theme }) => theme.sizing.medium}px;
`;
