import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme, type NKSTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  AppLayout,
  Avatar,
  LucideIcon,
  Typography,
} from '@ayphen/mobile-ui-components';
import { useActiveStoreStore } from '../activeStore';
import { useAuth } from '@core/providers/AuthProvider';
import { MORE_SECTIONS, type MenuColorToken, type MoreMenuItemConfig } from '@features/more/menu-config';

/**
 * More tab. Visually modeled on the reference app's MoreScreen (gradient
 * store card + grouped menu sections + logout row), but only shows data this
 * app actually has today — no role/plan/avatar data exists yet (no
 * subscription state), so those pieces of the reference UI are left out
 * rather than faked. The menu itself has no permission gating (no per-item
 * permission matrix exists yet) — every item is shown, and every item routes
 * to the same "Coming soon" placeholder until its real feature ships.
 */
function resolveMenuColor(theme: NKSTheme, token: MenuColorToken): string {
  switch (token) {
    case 'primary': return theme.colorPrimary;
    case 'success': return theme.colorSuccess;
    case 'warning': return theme.colorWarning;
    case 'error':   return theme.colorError;
    case 'info':    return theme.color?.blue?.main ?? '#2563EB';
    case 'violet':  return theme.color?.violet?.main ?? '#7C3AED';
    case 'teal':    return '#14B8A6';
    case 'neutral':
    default:        return '#64748B';
  }
}

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

  const openMenuItem = (item: MoreMenuItemConfig) => {
    router.push({
      pathname: '/(store)/more-detail',
      params: { label: item.label, description: item.description },
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
              colors={['#1E1B5E', '#3730A3']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
            >
              <StoreHeaderTop>
                <Avatar
                  iconName="Store"
                  size={48}
                  shape="circle"
                  bgColor="rgba(255,255,255,0.15)"
                  iconColor={theme.colorWhite}
                />
                <StoreInfoContainer>
                  <StoreTitleText numberOfLines={1}>{storeName}</StoreTitleText>
                </StoreInfoContainer>
              </StoreHeaderTop>

              <GradientDivider />
              <SwitchStoreRow
                onPress={leaveStore}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Switch to a different store"
              >
                <LucideIcon
                  name="ArrowLeftRight"
                  size={14}
                  color="rgba(255,255,255,0.75)"
                />
                <SwitchStoreText>Switch Store</SwitchStoreText>
                <LucideIcon
                  name="ChevronRight"
                  size={14}
                  color="rgba(255,255,255,0.4)"
                />
              </SwitchStoreRow>
            </StoreCardGradient>
          </StoreCardOuter>

          {MORE_SECTIONS.map((section) => (
            <View key={section.key}>
              <SectionLabel>{section.title}</SectionLabel>
              <GroupedCard>
                {section.items.map((item, i) => {
                  const color = resolveMenuColor(theme, item.iconColor);
                  const isLast = i === section.items.length - 1;
                  return (
                    <View key={item.key}>
                      <SectionRowPressable
                        onPress={() => openMenuItem(item)}
                        activeOpacity={0.6}
                        accessibilityRole="button"
                        accessibilityLabel={item.label}
                      >
                        <SectionIconContainer style={{ backgroundColor: `${color}15` }}>
                          <LucideIcon name={item.iconName} size={20} color={color} />
                        </SectionIconContainer>
                        <SectionContent>
                          <SectionTitle numberOfLines={1}>{item.label}</SectionTitle>
                          <SectionDescription numberOfLines={1}>{item.description}</SectionDescription>
                        </SectionContent>
                        <LucideIcon name="ChevronRight" size={16} color={theme.colorTextTertiary} />
                      </SectionRowPressable>
                      {!isLast && <RowDivider />}
                    </View>
                  );
                })}
              </GroupedCard>
            </View>
          ))}

          <LogoutCard>
            <LogoutRow
              onPress={handleLogout}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="Log out"
            >
              <SectionIconContainer
                style={{ backgroundColor: `${theme.colorError}15` }}
              >
                <LucideIcon name="LogOut" size={20} color={theme.colorError} />
              </SectionIconContainer>
              <LogoutLabel>Log out</LogoutLabel>
            </LogoutRow>
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

const StoreHeaderTop = styled(View)`
  flex-direction: row;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.small}px;
  padding: 16px 16px 12px;
`;

const StoreInfoContainer = styled(View)`
  flex: 1;
`;

const StoreTitleText = styled(Text)`
  color: ${({ theme }) => theme.colorWhite};
  font-size: 17px;
  font-weight: 700;
`;

const GradientDivider = styled(View)`
  height: 1px;
  background-color: rgba(255, 255, 255, 0.12);
  margin-left: 16px;
  margin-right: 16px;
`;

const SwitchStoreRow = styled(TouchableOpacity)`
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 11px 16px;
`;

const SwitchStoreText = styled(Text)`
  flex: 1;
  color: rgba(255, 255, 255, 0.8);
  font-size: 13px;
  font-weight: 600;
`;

const SectionIconContainer = styled(View)`
  width: 40px;
  height: 40px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  align-items: center;
  justify-content: center;
`;

const SectionLabel = styled(Text)`
  color: ${({ theme }) => theme.colorTextTertiary};
  font-size: 12px;
  font-weight: 600;
  margin-top: ${({ theme }) => theme.sizing.small}px;
  margin-bottom: ${({ theme }) => theme.sizing.xxSmall}px;
  padding-left: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const GroupedCard = styled(View)`
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  background-color: ${({ theme }) => theme.colorBgContainer};
  overflow: hidden;
`;

const SectionRowPressable = styled(TouchableOpacity)`
  flex-direction: row;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.small}px;
  padding: 14px ${({ theme }) => theme.sizing.medium}px;
`;

const RowDivider = styled(View)`
  height: 1px;
  background-color: ${({ theme }) => theme.colorBorderSecondary};
  margin-left: 60px;
`;

const SectionContent = styled(View)`
  flex: 1;
`;

const SectionTitle = styled(Typography.Body)`
  color: ${({ theme }) => theme.colorText};
  font-weight: 600;
  flex-shrink: 1;
`;

const SectionDescription = styled(Typography.Caption)`
  margin-top: 1px;
  color: ${({ theme }) => theme.colorTextSecondary};
`;

const LogoutCard = styled(View)`
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => `${theme.colorError}30`};
  background-color: ${({ theme }) => theme.colorBgContainer};
  overflow: hidden;
  margin-top: ${({ theme }) => theme.sizing.medium}px;
`;

const LogoutRow = styled(TouchableOpacity)`
  flex-direction: row;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.small}px;
  padding: 14px ${({ theme }) => theme.sizing.medium}px;
`;

const LogoutLabel = styled(Text)`
  flex: 1;
  font-size: 15px;
  font-weight: 600;
  color: ${({ theme }) => theme.colorError};
`;
