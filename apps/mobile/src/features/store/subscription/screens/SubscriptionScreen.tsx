import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  AppLayout,
  Column,
  Divider,
  GroupedMenu,
  LucideIcon,
  LucideIconNameType,
  Row,
  ScreenStateRenderer,
  Typography,
} from '@ayphen/mobile-ui-components';
import { useSubscriptionQuery } from '@ayphen/api-manager';
import type { BannerSeverity, SubscriptionResponse } from '@ayphen/api-manager';
import { SubscriptionLoading } from '../loading/SubscriptionLoading';

/**
 * Plan, usage, and billing — reached from More > Store Settings > Subscription.
 * Real data via GET /me/subscription (subscription.md §16/§19); the version
 * header on every response keeps this query fresh in the background — the axios
 * interceptor invalidates it when the version advances, so no polling here.
 *
 * Cancel/reactivate/checkout are NOT wired here yet — both require step-up
 * re-auth (server enforces it: `@StepUpAuth` on those routes) and there is no
 * step-up UI in the app yet (the OTP challenge needs the user's phone number,
 * which isn't in the client session today). Rendering those buttons without a
 * working handler would be the exact dead-control anti-pattern this feature
 * was audited against — so they're simply not here until step-up exists.
 */

// Fixed windows from the backend (subscription.service.ts BILLING_PERIOD_DAYS,
// store.service.ts TRIAL_DAYS) — the server never sends a period-start date, so
// the progress bar's "elapsed" fraction is derived against these constants
// rather than a real start timestamp. Decorative precision, not billing truth.
const TRIAL_WINDOW_DAYS = 15;
const BILLING_WINDOW_DAYS = 30;

const ENTITLEMENT_ROWS: Array<{
  key: string;
  label: string;
  iconName: LucideIconNameType;
}> = [
  { key: 'max_stores', label: 'Stores', iconName: 'Store' },
  {
    key: 'max_locations_per_store',
    label: 'Locations per store',
    iconName: 'MapPin',
  },
  {
    key: 'max_users_per_store',
    label: 'Staff per store',
    iconName: 'UsersRound',
  },
  {
    key: 'max_devices_per_store',
    label: 'Devices per store',
    iconName: 'Smartphone',
  },
];

const BANNER_COLOR_KEY: Record<
  Exclude<BannerSeverity, 'none'>,
  'primary' | 'warning' | 'danger'
> = {
  info: 'primary',
  warning: 'warning',
  critical: 'danger',
};

const BANNER_ICON: Record<
  Exclude<BannerSeverity, 'none'>,
  LucideIconNameType
> = {
  info: 'Info',
  warning: 'TriangleAlert',
  critical: 'CircleAlert',
};

function statusLabel(status: string): string {
  switch (status) {
    case 'trialing':
      return 'Trial';
    case 'active':
      return 'Active';
    case 'past_due':
      return 'Payment overdue';
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Expired';
    case 'paused':
      return 'Suspended';
    default:
      return status;
  }
}

function daysLeft(sub: SubscriptionResponse): number | null {
  const target =
    sub.status === 'trialing' ? sub.trial_ends_at : sub.current_period_end;
  if (!target) return null;
  const days = Math.ceil(
    (new Date(target).getTime() - Date.now()) / 86_400_000,
  );
  return days < 0 ? null : days;
}

function daysLeftLabel(sub: SubscriptionResponse): string | null {
  const days = daysLeft(sub);
  if (days === null) return null;
  if (sub.status === 'trialing')
    return `${days} day${days === 1 ? '' : 's'} left in your trial`;
  return `Renews in ${days} day${days === 1 ? '' : 's'}`;
}

/** Fraction of the trial/billing window already elapsed, clamped to [0.04, 1]
 *  so the bar always shows a sliver of progress rather than looking empty. */
function elapsedFraction(sub: SubscriptionResponse): number | null {
  const days = daysLeft(sub);
  if (days === null) return null;
  const window =
    sub.status === 'trialing' ? TRIAL_WINDOW_DAYS : BILLING_WINDOW_DAYS;
  return Math.min(1, Math.max(0.04, 1 - days / window));
}

export function SubscriptionScreen() {
  const { theme } = useMobileTheme();
  const {
    data: sub,
    isLoading,
    isError,
    refetch,
    isRefetching,
  } = useSubscriptionQuery();

  return (
    <AppLayout title="Subscription" onBack={() => router.back()}>
      <ScrollView
        contentContainerStyle={{
          padding: theme.sizing.large,
          paddingTop: theme.sizing.small,
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching && !isLoading}
            onRefresh={refetch}
          />
        }
      >
        <ScreenStateRenderer<SubscriptionResponse>
          isLoading={isLoading}
          isError={isError}
          data={sub}
          skeleton={<SubscriptionLoading />}
          error="Couldn't load your subscription."
          onRetry={() => refetch()}
        >
          {(data) => {
            // Single object was passed as `data` — narrow it back (the renderer
            // widens to `T | T[]`); only reached when sub is present.
            const sub = data as SubscriptionResponse;
            return (
              <Column gap={20}>
                {sub.reconciliation_status === 'pending' && (
                  <NoticeBanner $severity="critical">
                    <NoticeIconSlot $severity="critical">
                      <LucideIcon
                        name="CircleAlert"
                        size={16}
                        color={theme.colorError}
                      />
                    </NoticeIconSlot>
                    <Column gap={8} style={{ flex: 1 }}>
                      <Typography.Caption
                        color={theme.colorErrorText}
                        weight="semiBold"
                      >
                        Your plan changed and some stores, locations, or devices
                        are over the new limit. Choose what to keep — nothing is
                        deleted, but writes are blocked until you resolve this.
                      </Typography.Caption>
                      <ResolveLink
                        onPress={() =>
                          router.push('/(store)/downgrade-resolve')
                        }
                        activeOpacity={0.7}
                      >
                        <Typography.Caption
                          color={theme.colorError}
                          weight="bold"
                        >
                          Resolve now
                        </Typography.Caption>
                        <LucideIcon
                          name="ArrowRight"
                          size={14}
                          color={theme.colorError}
                        />
                      </ResolveLink>
                    </Column>
                  </NoticeBanner>
                )}

                {sub.show_upgrade_banner && sub.banner_severity !== 'none' && (
                  <NoticeBanner $severity={sub.banner_severity}>
                    <NoticeIconSlot $severity={sub.banner_severity}>
                      <LucideIcon
                        name={BANNER_ICON[sub.banner_severity]}
                        size={16}
                        color={
                          theme.color[BANNER_COLOR_KEY[sub.banner_severity]]
                            ?.main
                        }
                      />
                    </NoticeIconSlot>
                    <Typography.Caption
                      color={
                        theme.color[BANNER_COLOR_KEY[sub.banner_severity]]?.text
                      }
                      weight="medium"
                      style={{ flex: 1 }}
                    >
                      {sub.status === 'trialing'
                        ? (daysLeftLabel(sub) ?? 'Your trial is ending soon')
                        : sub.status === 'past_due'
                          ? 'Payment failed — renew to avoid interruption'
                          : sub.status === 'expired'
                            ? 'Your plan has expired'
                            : 'Action needed on your subscription'}
                    </Typography.Caption>
                  </NoticeBanner>
                )}

                <PlanCardShadow>
                  <PlanCardGradient
                    colors={[
                      theme.color.primary.main,
                      theme.color.primary.active,
                    ]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                  >
                    <Row align="center" justify="space-between">
                      <Row align="center" gap={8}>
                        <PlanIconBadge>
                          <LucideIcon
                            name="Sparkles"
                            size={16}
                            color={theme.colorWhite}
                          />
                        </PlanIconBadge>
                        <Typography.Overline color={theme.overlay.onDark55}>
                          CURRENT PLAN
                        </Typography.Overline>
                      </Row>
                      <StatusPill $status={sub.status}>
                        <Typography.Caption
                          weight="bold"
                          color={theme.colorWhite}
                        >
                          {statusLabel(sub.status)}
                        </Typography.Caption>
                      </StatusPill>
                    </Row>

                    <Typography.H2
                      weight="bold"
                      color={theme.colorWhite}
                      style={{ marginTop: theme.sizing.small }}
                    >
                      {sub.plan.name}
                    </Typography.H2>

                    {daysLeftLabel(sub) && (
                      <Column gap={6} style={{ marginTop: theme.sizing.small }}>
                        <ProgressTrack>
                          <ProgressFill
                            style={{
                              width: `${(elapsedFraction(sub) ?? 0) * 100}%`,
                            }}
                          />
                        </ProgressTrack>
                        <Typography.Caption
                          color={theme.colorWhite}
                          weight="medium"
                        >
                          {daysLeftLabel(sub)}
                        </Typography.Caption>
                      </Column>
                    )}

                    <ViewPlansButton
                      onPress={() => router.push('/(store)/subscription-plans')}
                      activeOpacity={0.85}
                    >
                      <Typography.Body
                        weight="bold"
                        color={theme.color.primary.main}
                      >
                        View plans
                      </Typography.Body>
                      <LucideIcon
                        name="ArrowRight"
                        size={16}
                        color={theme.color.primary.main}
                      />
                    </ViewPlansButton>
                  </PlanCardGradient>
                </PlanCardShadow>

                <Column gap={10}>
                  <Typography.Subtitle weight="bold">
                    Plan limits
                  </Typography.Subtitle>
                  <LimitsCard>
                    {ENTITLEMENT_ROWS.map((row, i) => {
                      const limit = sub.plan.entitlements[row.key];
                      return (
                        <View key={row.key}>
                          <Row
                            align="center"
                            justify="space-between"
                            style={{
                              paddingVertical: theme.sizing.small,
                              paddingHorizontal: theme.sizing.medium,
                            }}
                          >
                            <Row align="center" gap={10}>
                              <LimitIconSlot>
                                <LucideIcon
                                  name={row.iconName}
                                  size={16}
                                  color={theme.color.primary.main}
                                />
                              </LimitIconSlot>
                              <Typography.Body>{row.label}</Typography.Body>
                            </Row>
                            <Typography.Body weight="bold">
                              {limit === null || limit === undefined
                                ? 'Unlimited'
                                : limit}
                            </Typography.Body>
                          </Row>
                          {i < ENTITLEMENT_ROWS.length - 1 && (
                            <Divider
                              color={theme.colorBorderSecondary}
                              thickness={1}
                              marginVertical={0}
                              insetLeft={46}
                            />
                          )}
                        </View>
                      );
                    })}
                  </LimitsCard>
                </Column>

                <GroupedMenu
                  data={[
                    {
                      label: 'Billing',
                      items: [
                        {
                          icon: 'Receipt',
                          iconColor: theme.color?.blue?.main,
                          title: 'Billing & invoices',
                          subtitle: 'Coming soon',
                          disabled: true,
                        },
                        {
                          icon: 'Wallet',
                          iconColor: theme.color?.violet?.main,
                          title: 'Payment method',
                          subtitle: 'Coming soon',
                          disabled: true,
                        },
                      ],
                    },
                  ]}
                />
              </Column>
            );
          }}
        </ScreenStateRenderer>
      </ScrollView>
    </AppLayout>
  );
}

// ─── Hero plan card ─────────────────────────────────────────────────────────

const PlanCardShadow = styled(View)`
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  ${({ theme }) => theme.shadow.lg}
`;

const PlanCardGradient = styled(LinearGradient)`
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  padding: ${({ theme }) => theme.sizing.large}px;
  overflow: hidden;
`;

const PlanIconBadge = styled(View)`
  width: 26px;
  height: 26px;
  border-radius: ${({ theme }) => theme.borderRadius.regular}px;
  background-color: ${({ theme }) => theme.overlay.onDark20};
  align-items: center;
  justify-content: center;
`;

const StatusPill = styled(View)<{ $status: string }>`
  padding: 5px 12px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  background-color: ${({ $status, theme }) =>
    $status === 'past_due' || $status === 'expired' || $status === 'paused'
      ? theme.color.danger.bg
      : theme.overlay.onDark20};
`;

const ProgressTrack = styled(View)`
  height: 6px;
  border-radius: ${({ theme }) => theme.borderRadius.xSmall}px;
  background-color: ${({ theme }) => theme.overlay.onDark20};
  overflow: hidden;
`;

const ProgressFill = styled(View)`
  height: 6px;
  border-radius: ${({ theme }) => theme.borderRadius.xSmall}px;
  background-color: ${({ theme }) => theme.colorWhite};
`;

const ViewPlansButton = styled.TouchableOpacity`
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: ${({ theme }) => theme.sizing.medium}px;
  background-color: ${({ theme }) => theme.colorWhite};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  padding: 13px;
`;

// ─── Plan limits ────────────────────────────────────────────────────────────

const LimitsCard = styled(View)`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  overflow: hidden;
`;

const LimitIconSlot = styled(View)`
  width: 30px;
  height: 30px;
  border-radius: ${({ theme }) => theme.borderRadius.regular}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme }) => theme.color.primary.bg};
`;

// ─── Notice banners ─────────────────────────────────────────────────────────

const NoticeBanner = styled(View)<{ $severity: BannerSeverity }>`
  flex-direction: row;
  align-items: flex-start;
  gap: ${({ theme }) => theme.sizing.xSmall}px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  padding: ${({ theme }) => theme.sizing.medium}px;
  background-color: ${({ theme, $severity }) =>
    $severity === 'critical'
      ? theme.colorErrorBg
      : $severity === 'warning'
        ? theme.colorWarningBg
        : theme.color.primary.bg};
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme, $severity }) =>
    $severity === 'critical'
      ? theme.colorErrorBorder
      : $severity === 'warning'
        ? theme.colorWarningBorder
        : theme.colorBorder};
`;

const NoticeIconSlot = styled(View)<{ $severity: BannerSeverity }>`
  width: 28px;
  height: 28px;
  border-radius: ${({ theme }) => theme.borderRadius.regular}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme, $severity }) =>
    $severity === 'critical'
      ? theme.colorErrorBgHover
      : $severity === 'warning'
        ? theme.colorWarningBgHover
        : theme.color.primary.bgActive};
`;

const ResolveLink = styled.TouchableOpacity`
  flex-direction: row;
  align-items: center;
  gap: 4px;
  align-self: flex-start;
`;
