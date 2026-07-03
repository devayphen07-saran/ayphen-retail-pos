import { useMemo } from 'react';
import { Pressable, ScrollView, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme, type NKSTheme } from '@ayphen/mobile-theme';
import { AppLayout, LucideIcon, Typography } from '@ayphen/mobile-ui-components';
import { useActiveStoreStore } from '../activeStore';

/**
 * Store dashboard — the Home tab. Visually modeled on the reference app's
 * DashboardScreen (greeting header + hero metrics + quick actions + recent
 * products), but only shows data this app actually has today — there's no
 * orders/products/sync/RBAC/subscription backend wired into mobile yet (same
 * situation MoreScreen.tsx already documents), so:
 *  - sales/product-count/recent-products are honest zero-states, not faked
 *    numbers, since POS/Products are still "Coming soon" stubs
 *  - the reference's third metric (offline sync status) is replaced with
 *    real data (location count) since no sync engine exists to report on
 *  - "Pending payments" is dropped rather than built for permanently-empty
 *    data — the reference itself only renders that section when non-empty
 *  - no PermissionGate / TrialBanner / StorePickerModal — none of that
 *    infra exists on mobile; every action is shown, "switch store" reuses
 *    the same clear+redirect flow MoreScreen already uses
 */
export function StoreHomeScreen() {
  const { theme } = useMobileTheme();
  const store = useActiveStoreStore((s) => s.store);
  const clearActiveStore = useActiveStoreStore((s) => s.clearActiveStore);

  const storeName = store?.name || 'Unknown store';
  const locationCount = store?.locations?.length ?? 0;

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);

  const openPos = () => router.push('/(store)/(tabs)/pos');
  const openProducts = () => router.push('/(store)/(tabs)/products');
  const openCustomers = () => router.push('/(store)/(tabs)/customer');
  const openMore = () => router.push('/(store)/(tabs)/more');

  const openNotifications = () =>
    router.push({
      pathname: '/(store)/more-detail',
      params: { label: 'Notifications' },
    });

  const switchStore = () => {
    clearActiveStore();
    router.replace('/(app)/store-picker');
  };

  const headerRow = (
    <Header>
      <HeaderLeft>
        <HeaderGreeting numberOfLines={1}>{greeting}!</HeaderGreeting>
        <TouchableOpacity
          onPress={switchStore}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Current store: ${storeName}. Tap to switch.`}
        >
          <HeaderStoreRow>
            <LucideIcon name="Store" size={13} color={theme.colorPrimary} />
            <HeaderStoreText numberOfLines={1}>{storeName}</HeaderStoreText>
            <LucideIcon name="ChevronDown" size={13} color={theme.colorTextSecondary} />
          </HeaderStoreRow>
        </TouchableOpacity>
      </HeaderLeft>

      <HeaderRight>
        <HeaderIconBtn
          onPress={openNotifications}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="Notifications"
        >
          <LucideIcon name="Bell" size={20} color={theme.colorText} />
        </HeaderIconBtn>
        <HeaderIconBtn
          onPress={openMore}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="Profile"
        >
          <LucideIcon name="User" size={20} color={theme.colorText} />
        </HeaderIconBtn>
      </HeaderRight>
    </Header>
  );

  return (
    <AppLayout title="Home" headerRow={headerRow}>
      <Content
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        {/* ── Metrics card ─────────────────────────────────────────── */}
        <HeroCard>
          <HeroMetricsRow>
            <HeroMetric onPress={openPos} accessibilityRole="button">
              <HeroMetricLabel>Today's sales</HeroMetricLabel>
              <HeroMetricValue>₹0</HeroMetricValue>
              <HeroMetricMeta style={{ color: theme.colorPrimary }}>Start a sale →</HeroMetricMeta>
            </HeroMetric>

            <HeroDivider />

            <HeroMetric onPress={openProducts} accessibilityRole="button">
              <HeroMetricLabel>Products</HeroMetricLabel>
              <HeroMetricValue>0</HeroMetricValue>
              <HeroMetricMeta style={{ color: theme.colorPrimary }}>Add first →</HeroMetricMeta>
            </HeroMetric>

            <HeroDivider />

            <HeroMetric accessibilityRole="text">
              <HeroMetricLabel>Locations</HeroMetricLabel>
              <HeroMetricValue>{locationCount}</HeroMetricValue>
              <HeroMetricMeta>{locationCount === 1 ? 'location' : 'locations'}</HeroMetricMeta>
            </HeroMetric>
          </HeroMetricsRow>
        </HeroCard>

        {/* ── Quick actions ──────────────────────────────────────────── */}
        <Section>
          <SectionLabel>Quick actions</SectionLabel>
          <QuickRow>
            <QuickItem onPress={openPos} accessibilityRole="button" accessibilityLabel="Open POS">
              <QuickIcon $bg={theme.colorPrimary}>
                <LucideIcon name="ShoppingCart" size={22} color={theme.colorWhite} />
              </QuickIcon>
              <QuickText>Open POS</QuickText>
            </QuickItem>

            <QuickItem onPress={openProducts} accessibilityRole="button" accessibilityLabel="Add product">
              <QuickIcon $bg={theme.colorSuccessBg}>
                <LucideIcon name="PackagePlus" size={22} color={theme.colorSuccess} />
              </QuickIcon>
              <QuickText>Add Product</QuickText>
            </QuickItem>

            <QuickItem onPress={openCustomers} accessibilityRole="button" accessibilityLabel="View customers">
              <QuickIcon $bg={`${resolveInfoColor(theme)}14`}>
                <LucideIcon name="Users" size={22} color={resolveInfoColor(theme)} />
              </QuickIcon>
              <QuickText>View Customers</QuickText>
            </QuickItem>
          </QuickRow>
        </Section>

        {/* ── Recent products ─────────────────────────────────────────── */}
        <Section>
          <SectionHeaderRow>
            <SectionLabel>Recent products</SectionLabel>
          </SectionHeaderRow>

          <EmptyCard>
            <EmptyIconBox>
              <LucideIcon name="Package" size={26} color={theme.colorTextTertiary} />
            </EmptyIconBox>
            <EmptyTitle>No products yet</EmptyTitle>
            <EmptyDesc>Tap "Add Product" above to get started</EmptyDesc>
          </EmptyCard>
        </Section>
      </Content>
    </AppLayout>
  );
}

function resolveInfoColor(theme: NKSTheme): string {
  return theme.color?.blue?.main ?? theme.colorPrimary;
}

// ── Header ────────────────────────────────────────────────────────────────────

const Header = styled(View)`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  min-height: 64px;
  padding-left: ${({ theme }) => theme.sizing.medium}px;
  padding-right: ${({ theme }) => theme.sizing.small}px;
  padding-top: 10px;
  padding-bottom: 10px;
  background-color: ${({ theme }) => theme.colorBgContainer};
`;

const HeaderLeft = styled(View)`
  flex: 1;
  gap: 3px;
`;

const HeaderGreeting = styled(Typography.H4)`
  color: ${({ theme }) => theme.colorText};
  letter-spacing: -0.3px;
`;

const HeaderStoreRow = styled(View)`
  flex-direction: row;
  align-items: center;
  gap: 5px;
`;

const HeaderStoreText = styled(Typography.Caption)`
  font-weight: 500;
  color: ${({ theme }) => theme.colorTextSecondary};
  max-width: 180px;
`;

const HeaderRight = styled(View)`
  flex-direction: row;
  align-items: center;
  gap: 6px;
`;

const HeaderIconBtn = styled(TouchableOpacity)`
  width: 36px;
  height: 36px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  background-color: ${({ theme }) => theme.colorBgElevated ?? theme.colorBgContainer};
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
  align-items: center;
  justify-content: center;
`;

// ── Content ───────────────────────────────────────────────────────────────────

const Content = styled(ScrollView)`
  flex: 1;
  background-color: ${({ theme }) => theme.colorBgLayout};
`;

// ── Hero card ─────────────────────────────────────────────────────────────────

const HeroCard = styled(View)`
  margin: ${({ theme }) => theme.sizing.small}px ${({ theme }) => theme.sizing.medium}px 0;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
  padding: 14px 0;
`;

const HeroMetricsRow = styled(View)`
  flex-direction: row;
  align-items: stretch;
`;

const HeroMetric = styled(Pressable)`
  flex: 1;
  align-items: center;
  gap: 2px;
`;

const HeroDivider = styled(View)`
  width: 1px;
  background-color: ${({ theme }) => theme.colorBorderSecondary};
  margin-top: ${({ theme }) => theme.sizing.xxSmall}px;
  margin-bottom: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const HeroMetricLabel = styled(Typography.Caption)`
  font-weight: 500;
  color: ${({ theme }) => theme.colorTextSecondary};
`;

const HeroMetricValue = styled(Typography.H4)`
  color: ${({ theme }) => theme.colorText};
  letter-spacing: -0.3px;
`;

const HeroMetricMeta = styled(Typography.Caption)`
  color: ${({ theme }) => theme.colorTextTertiary};
`;

// ── Sections ──────────────────────────────────────────────────────────────────

const Section = styled(View)`
  padding: ${({ theme }) => theme.sizing.medium}px ${({ theme }) => theme.sizing.medium}px 0;
`;

const SectionHeaderRow = styled(View)`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  margin-bottom: ${({ theme }) => theme.sizing.xSmall}px;
`;

const SectionLabel = styled(Typography.Caption)`
  font-weight: 600;
  color: ${({ theme }) => theme.colorTextSecondary};
`;

// ── Quick actions ─────────────────────────────────────────────────────────────

const QuickRow = styled(View)`
  flex-direction: row;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
  padding: 14px ${({ theme }) => theme.sizing.xSmall}px ${({ theme }) => theme.sizing.small}px;
`;

const QuickItem = styled(Pressable)`
  flex: 1;
  align-items: center;
  gap: 6px;
`;

const QuickIcon = styled(View)<{ $bg: string }>`
  width: 48px;
  height: 48px;
  border-radius: 14px;
  background-color: ${({ $bg }) => $bg};
  align-items: center;
  justify-content: center;
`;

const QuickText = styled(Typography.Caption)`
  font-weight: 600;
  color: ${({ theme }) => theme.colorText};
  text-align: center;
`;

// ── Empty state ───────────────────────────────────────────────────────────────

const EmptyCard = styled(View)`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  padding: 28px ${({ theme }) => theme.sizing.regular}px;
  align-items: center;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
  gap: 6px;
`;

const EmptyIconBox = styled(View)`
  width: 52px;
  height: 52px;
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  background-color: ${({ theme }) => theme.colorFillTertiary};
  align-items: center;
  justify-content: center;
  margin-bottom: 6px;
`;

const EmptyTitle = styled(Typography.Body)`
  font-weight: 700;
  color: ${({ theme }) => theme.colorText};
`;

const EmptyDesc = styled(Typography.Caption)`
  color: ${({ theme }) => theme.colorTextSecondary};
  text-align: center;
  max-width: 240px;
`;