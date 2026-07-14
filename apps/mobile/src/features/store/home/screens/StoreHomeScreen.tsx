import { useMemo, useState } from 'react';
import { Pressable, ScrollView, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme, type MobileTheme } from '@ayphen/mobile-theme';
import { AppLayout, Column, LucideIcon, Row, Typography } from '@ayphen/mobile-ui-components';
import { useStoreSetupStatusQuery, type StoreSetupStatusResponse } from '@ayphen/api-manager';
import { useActiveStoreStore, useActiveStoreContext } from '@store';

/**
 * Store dashboard — the Home tab. Visually modeled on the reference app's
 * DashboardScreen (greeting header + hero metrics + quick actions + recent
 * products), but only shows data this app actually has today — there's no
 * orders/products/sync/RBAC/subscription backend wired into mobile yet (same
 * situation MoreScreen.tsx already documents), so:
 *  - sales/product-count/recent-products are honest zero-states, not faked
 *    numbers, since POS/Products are still "Coming soon" stubs
 *  - the reference's third metric (offline sync status) is dropped rather
 *    than faked, since no sync engine exists to report on
 *  - "Pending payments" is dropped rather than built for permanently-empty
 *    data — the reference itself only renders that section when non-empty
 *  - no PermissionGate / TrialBanner / StorePickerModal — none of that
 *    infra exists on mobile; every action is shown, "switch store" reuses
 *    the same clear+redirect flow MoreScreen already uses
 */
export function StoreHomeScreen() {
  const { theme } = useMobileTheme();
  const store = useActiveStoreContext();
  const storeId = useActiveStoreStore((s) => s.storeId);
  const clearActiveStore = useActiveStoreStore((s) => s.clearActiveStore);
  const { data: setupStatus } = useStoreSetupStatusQuery(storeId ?? '', {
    enabled: !!storeId,
  });

  const storeName = store?.name || 'Unknown store';

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);

  const openPos = () => router.push('/(store)/(tabs)/pos');
  const openProducts = () => router.push('/(store)/(tabs)/products');
  const openCustomers = () => router.push('/(store)/(tabs)/customer');
  const openProfile = () => router.push('/(store)/profile');

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
    <Header align="center" justify="space-between">
      <Column flex={1} gap={3}>
        <TightH4 numberOfLines={1} color={theme.colorText}>
          {greeting}!
        </TightH4>
        <TouchableOpacity
          onPress={switchStore}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Current store: ${storeName}. Tap to switch.`}
        >
          <Row align="center" gap={5}>
            <LucideIcon name="Store" size={13} color={theme.colorPrimary} />
            <StoreNameCaption
              numberOfLines={1}
              weight={500}
              color={theme.colorTextSecondary}
            >
              {storeName}
            </StoreNameCaption>
            <LucideIcon name="ChevronDown" size={13} color={theme.colorTextSecondary} />
          </Row>
        </TouchableOpacity>
      </Column>

      <Row align="center" gap={6}>
        <HeaderIconBtn
          onPress={openNotifications}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="Notifications"
        >
          <LucideIcon name="Bell" size={20} color={theme.colorText} />
        </HeaderIconBtn>
        <HeaderIconBtn
          onPress={openProfile}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="Profile"
        >
          <LucideIcon name="User" size={20} color={theme.colorText} />
        </HeaderIconBtn>
      </Row>
    </Header>
  );

  return (
    <AppLayout title="Home" headerRow={headerRow}>
      <Content showsVerticalScrollIndicator={false}>
        {/* ── Metrics card ─────────────────────────────────────────── */}
        <HeroCard>
          <Row align="stretch">
            <HeroMetric onPress={openPos} accessibilityRole="button">
              <Typography.Caption weight={500} color={theme.colorTextSecondary}>
                Today's sales
              </Typography.Caption>
              <TightH4 color={theme.colorText}>₹0</TightH4>
              <Typography.Caption color={theme.colorPrimary}>
                Start a sale →
              </Typography.Caption>
            </HeroMetric>

            <HeroDivider />

            <HeroMetric onPress={openProducts} accessibilityRole="button">
              <Typography.Caption weight={500} color={theme.colorTextSecondary}>
                Products
              </Typography.Caption>
              <TightH4 color={theme.colorText}>0</TightH4>
              <Typography.Caption color={theme.colorPrimary}>
                Add first →
              </Typography.Caption>
            </HeroMetric>
          </Row>
        </HeroCard>

        {/* ── Setup checklist — only rendered while genuinely incomplete ── */}
        {setupStatus && setupStatus.completion_percentage < 100 && (
          <SetupProgressCard status={setupStatus} theme={theme} />
        )}

        {/* ── Quick actions ──────────────────────────────────────────── */}
        <Section>
          <Typography.Caption weight={600} color={theme.colorTextSecondary}>
            Quick actions
          </Typography.Caption>
          <QuickRow>
            <QuickItem onPress={openPos} accessibilityRole="button" accessibilityLabel="Open POS">
              <QuickIcon $bg={theme.colorPrimary}>
                <LucideIcon name="ShoppingCart" size={22} color={theme.colorWhite} />
              </QuickIcon>
              <QuickLabel weight={600} color={theme.colorText}>
                Open POS
              </QuickLabel>
            </QuickItem>

            <QuickItem onPress={openProducts} accessibilityRole="button" accessibilityLabel="Add product">
              <QuickIcon $bg={theme.colorSuccessBg}>
                <LucideIcon name="PackagePlus" size={22} color={theme.colorSuccess} />
              </QuickIcon>
              <QuickLabel weight={600} color={theme.colorText}>
                Add Product
              </QuickLabel>
            </QuickItem>

            <QuickItem onPress={openCustomers} accessibilityRole="button" accessibilityLabel="View customers">
              <QuickIcon $bg={`${resolveInfoColor(theme)}14`}>
                <LucideIcon name="Users" size={22} color={resolveInfoColor(theme)} />
              </QuickIcon>
              <QuickLabel weight={600} color={theme.colorText}>
                View Customers
              </QuickLabel>
            </QuickItem>
          </QuickRow>
        </Section>

        {/* ── Recent products ─────────────────────────────────────────── */}
        <Section>
          <SectionHeaderRow align="center" justify="space-between">
            <Typography.Caption weight={600} color={theme.colorTextSecondary}>
              Recent products
            </Typography.Caption>
          </SectionHeaderRow>

          <EmptyCard>
            <EmptyIconBox>
              <LucideIcon name="Package" size={26} color={theme.colorTextTertiary} />
            </EmptyIconBox>
            <Typography.Body weight={700} color={theme.colorText}>
              No products yet
            </Typography.Body>
            <EmptyCardCaption color={theme.colorTextSecondary}>
              Tap "Add Product" above to get started
            </EmptyCardCaption>
          </EmptyCard>
        </Section>
      </Content>
    </AppLayout>
  );
}

function resolveInfoColor(theme: MobileTheme): string {
  return theme.color?.blue?.main ?? theme.colorPrimary;
}

// ── Setup checklist card ─────────────────────────────────────────────────────

interface SetupChecklistItem {
  key: keyof StoreSetupStatusResponse['status_map'];
  label: string;
  onPress: () => void;
}

const SETUP_CHECKLIST: SetupChecklistItem[] = [
  {
    key:     'store_profile_complete',
    label:   'Complete store profile',
    onPress: () =>
      router.push({ pathname: '/(store)/more-section', params: { sectionKey: 'store' } }),
  },
  {
    key:     'staff_invited',
    label:   'Invite your team',
    onPress: () => router.push('/(store)/invite-staff'),
  },
  {
    key:     'product_added',
    label:   'Add your first product',
    onPress: () => router.push('/(store)/(tabs)/products'),
  },
  {
    key:     'payment_configured',
    label:   'Set up a payment account',
    onPress: () =>
      router.push({ pathname: '/(store)/more-section', params: { sectionKey: 'store' } }),
  },
  {
    key:     'device_linked',
    label:   'Trust a device',
    onPress: () => router.push('/(store)/my-devices'),
  },
];

function SetupProgressCard({
  status,
  theme,
}: {
  status: StoreSetupStatusResponse;
  theme: MobileTheme;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <Section>
      <SetupCard>
        <TouchableOpacity
          onPress={() => setExpanded((v) => !v)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Setup checklist, ${status.completion_percentage}% complete. Tap to ${
            expanded ? 'collapse' : 'expand'
          }.`}
        >
          <Row align="center" justify="space-between">
            <Row align="center" gap={8} flex={1}>
              <Typography.Body weight={700} color={theme.colorText}>
                Finish setting up your store
              </Typography.Body>
            </Row>
            <Row align="center" gap={6}>
              <Typography.Caption weight={600} color={theme.colorPrimary}>
                {status.completion_percentage}%
              </Typography.Caption>
              <LucideIcon
                name={expanded ? 'ChevronUp' : 'ChevronDown'}
                size={16}
                color={theme.colorTextTertiary}
              />
            </Row>
          </Row>

          <ProgressTrack>
            <ProgressFill $percent={status.completion_percentage} $color={theme.colorPrimary} />
          </ProgressTrack>
        </TouchableOpacity>

        {expanded && (
        <Column gap={2}>
          {SETUP_CHECKLIST.map((item) => {
            const done = status.status_map[item.key];
            return (
              <ChecklistRow
                key={item.key}
                onPress={item.onPress}
                disabled={done}
                accessibilityRole="button"
                accessibilityLabel={item.label}
              >
                <Row align="center" gap={10} flex={1}>
                  <LucideIcon
                    name={done ? 'CheckCircle2' : 'Circle'}
                    size={18}
                    color={done ? theme.colorSuccess : theme.colorTextTertiary}
                  />
                  <ChecklistLabel
                    weight={500}
                    color={done ? theme.colorTextTertiary : theme.colorText}
                    $done={done}
                  >
                    {item.label}
                  </ChecklistLabel>
                </Row>
                {!done && (
                  <LucideIcon name="ChevronRight" size={16} color={theme.colorTextTertiary} />
                )}
              </ChecklistRow>
            );
          })}
        </Column>
        )}
      </SetupCard>
    </Section>
  );
}

// ── Header ────────────────────────────────────────────────────────────────────

const Header = styled(Row)`
  min-height: 64px;
  padding-left: ${({ theme }) => theme.sizing.medium}px;
  padding-right: ${({ theme }) => theme.sizing.small}px;
  padding-top: ${({ theme }) => theme.sizing.xSmall}px;
  padding-bottom: ${({ theme }) => theme.sizing.xSmall}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
`;

const TightH4 = styled(Typography.H4)`
  letter-spacing: -0.3px;
`;

const StoreNameCaption = styled(Typography.Caption)`
  max-width: 180px;
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

const Content = styled(ScrollView).attrs(({ theme }) => ({
  contentContainerStyle: { paddingBottom: theme.sizing.large },
}))`
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
  padding: ${({ theme }) => theme.sizing.small}px 0;
`;

const HeroMetric = styled(Pressable)`
  flex: 1;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const HeroDivider = styled(View)`
  width: 1px;
  background-color: ${({ theme }) => theme.colorBorderSecondary};
  margin-top: ${({ theme }) => theme.sizing.xxSmall}px;
  margin-bottom: ${({ theme }) => theme.sizing.xxSmall}px;
`;

// ── Setup checklist card ─────────────────────────────────────────────────────

const SetupCard = styled(View)`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
  padding: ${({ theme }) => theme.sizing.regular}px;
  gap: ${({ theme }) => theme.sizing.small}px;
`;

const ProgressTrack = styled(View)`
  height: 6px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  background-color: ${({ theme }) => theme.colorFillTertiary};
  overflow: hidden;
  margin-top: ${({ theme }) => theme.sizing.small}px;
`;

const ProgressFill = styled(View)<{ $percent: number; $color: string }>`
  height: 100%;
  width: ${({ $percent }) => $percent}%;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  background-color: ${({ $color }) => $color};
`;

const ChecklistRow = styled(TouchableOpacity)`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: ${({ theme }) => theme.sizing.xxSmall}px 0;
`;

const ChecklistLabel = styled(Typography.Caption)<{ $done?: boolean }>`
  text-decoration-line: ${({ $done }) => ($done ? 'line-through' : 'none')};
`;

// ── Sections ──────────────────────────────────────────────────────────────────

const Section = styled(View)`
  padding: ${({ theme }) => theme.sizing.medium}px ${({ theme }) => theme.sizing.medium}px 0;
`;

const SectionHeaderRow = styled(Row)`
  margin-bottom: ${({ theme }) => theme.sizing.xSmall}px;
`;

// ── Quick actions ─────────────────────────────────────────────────────────────

const QuickRow = styled(View)`
  flex-direction: row;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
  padding: ${({ theme }) => theme.sizing.small}px ${({ theme }) => theme.sizing.xSmall}px ${({ theme }) => theme.sizing.small}px;
`;

const QuickItem = styled(Pressable)`
  flex: 1;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const QuickIcon = styled(View)<{ $bg: string }>`
  width: 48px;
  height: 48px;
  border-radius: ${({ theme }) => theme.borderRadius.xxLarge}px;
  background-color: ${({ $bg }) => $bg};
  align-items: center;
  justify-content: center;
`;

const QuickLabel = styled(Typography.Caption)`
  text-align: center;
`;

// ── Empty state ───────────────────────────────────────────────────────────────

const EmptyCard = styled(View)`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  padding: ${({ theme }) => theme.sizing.large}px ${({ theme }) => theme.sizing.regular}px;
  align-items: center;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
  gap: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const EmptyCardCaption = styled(Typography.Caption)`
  text-align: center;
  max-width: 240px;
`;

const EmptyIconBox = styled(View)`
  width: 52px;
  height: 52px;
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  background-color: ${({ theme }) => theme.colorFillTertiary};
  align-items: center;
  justify-content: center;
  margin-bottom: ${({ theme }) => theme.sizing.xxSmall}px;
`;