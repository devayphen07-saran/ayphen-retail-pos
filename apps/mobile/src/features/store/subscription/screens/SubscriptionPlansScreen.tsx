import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  AppLayout,
  Column,
  LucideIcon,
  Row,
  ScreenStateRenderer,
  Typography,
  useBottomSheet,
} from '@ayphen/mobile-ui-components';
import { useSubscriptionPlansQuery, useSubscriptionQuery } from '@ayphen/api-manager';
import type { PlanCatalogEntry, PlanPricingOption } from '@ayphen/api-manager';
import { SubscriptionPlansLoading } from '../loading/SubscriptionPlansLoading';
import { ConfirmCheckoutSheet } from '../components/ConfirmCheckoutSheet';
import { TrustItem } from '../components/TrustItem';

/**
 * GET /me/subscription/plans (subscription.md §3, §22B — cache ~24h, react-query
 * default staleTime on this query already does that). One global Monthly/Annual
 * toggle drives every card's price + CTA — selecting a cycle opens a brief
 * confirmation sheet, then starts checkout (SubscriptionCheckoutScreen →
 * Razorpay WebView, no native SDK). The recommended plan is called out inline
 * on its own card (badge + accent border) rather than a separate spotlight;
 * the "compare limits" table at the bottom reads straight off each plan's
 * real `entitlements` (never duplicated/hand-typed).
 */
type Cycle = 'monthly' | 'annual';

function formatMajor(amount: number, currency: string): string {
  const major = amount / 100;
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${symbol}${major.toLocaleString('en-IN')}`;
}

function formatPrice(option: PlanPricingOption): string {
  const cadence = option.billing_cycle === 'annual' ? '/year' : '/month';
  return `${formatMajor(option.amount, option.currency)}${cadence}`;
}

function formatLimit(limit: number | null | undefined): string {
  return limit === null || limit === undefined ? '∞' : String(limit);
}

const COMPARISON_ROWS: Array<{ key: string; label: string }> = [
  { key: 'max_stores', label: 'Stores' },
  { key: 'max_devices_per_store', label: 'Devices per store' },
  { key: 'max_products', label: 'Products' },
];

type Cta =
  | { kind: 'current' }
  | { kind: 'none' }
  | { kind: 'upgrade' | 'downgrade'; option: PlanPricingOption };

function resolveCta(
  plan: PlanCatalogEntry,
  cycle: Cycle,
  currentPlanName: string | undefined,
  currentDisplayOrder: number,
): Cta {
  if (plan.plan_name === currentPlanName) return { kind: 'current' };
  const option = plan.pricing.find((o) => o.billing_cycle === cycle);
  if (!option) return { kind: 'none' };
  return { kind: plan.display_order > currentDisplayOrder ? 'upgrade' : 'downgrade', option };
}

export function SubscriptionPlansScreen() {
  const { theme } = useMobileTheme();
  const { data: plans, isLoading, isError, refetch } = useSubscriptionPlansQuery();
  const { data: sub } = useSubscriptionQuery();
  const sheet = useBottomSheet();
  const [cycle, setCycle] = useState<Cycle>('monthly');

  const maxAnnualSavings = useMemo(() => {
    const all = (plans ?? []).flatMap((p) => p.pricing).filter((o) => o.billing_cycle === 'annual');
    return all.reduce((max, o) => Math.max(max, o.savings_percentage), 0);
  }, [plans]);

  // `feature_labels` is identical on every plan entry (backend-owned copy) —
  // union across plans defensively rather than assuming plans[0] has them all.
  const featureRows = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const p of plans ?? []) Object.assign(labels, p.feature_labels);
    return Object.entries(labels).map(([key, label]) => ({ key, label }));
  }, [plans]);

  const currency = plans?.flatMap((p) => p.pricing)[0]?.currency ?? 'INR';

  const currentDisplayOrder =
    plans?.find((p) => p.plan_name === sub?.plan.code)?.display_order ?? -1;

  const startCheckout = (plan: PlanCatalogEntry, option: PlanPricingOption, kind: 'upgrade' | 'downgrade') => {
    sheet.open({
      Component: ConfirmCheckoutSheet,
      snapPoint: 'sm',
      title: 'Confirm plan change',
      props: {
        displayName: `${plan.display_name} · ${option.billing_cycle === 'annual' ? 'Annual' : 'Monthly'}`,
        priceLabel: formatPrice(option),
        isDowngrade: kind === 'downgrade',
        onConfirm: () => {
          sheet.close();
          router.push({
            pathname: '/(store)/subscription-checkout',
            params: { planCode: option.plan_code },
          });
        },
        onCancel: () => sheet.close(),
      },
    });
  };

  return (
    <AppLayout title="Plans" onBack={() => router.back()}>
      <ScrollView
        contentContainerStyle={{ padding: theme.sizing.large, flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
      >
        <ScreenStateRenderer
          isLoading={isLoading}
          isError={isError}
          data={plans}
          skeleton={<SubscriptionPlansLoading />}
          emptyTitle="No plans available"
          emptyDescription="We couldn't find any plans to show right now."
          onRetry={() => refetch()}
        >
          {() => (
          <Column gap={20}>
            <Column gap={6}>
              <Typography.H4 weight="bold">Upgrade your workspace</Typography.H4>
              <Typography.Caption type="secondary">
                Select the limits your stores need today.
              </Typography.Caption>
            </Column>

            <CycleToggleTrack>
              <CycleTab $selected={cycle === 'monthly'} onPress={() => setCycle('monthly')} activeOpacity={0.85}>
                <Typography.Body weight="bold" color={cycle === 'monthly' ? theme.colorWhite : theme.colorTextSecondary}>
                  Monthly
                </Typography.Body>
              </CycleTab>
              <CycleTab $selected={cycle === 'annual'} onPress={() => setCycle('annual')} activeOpacity={0.85}>
                <Row align="center" gap={6}>
                  <Typography.Body weight="bold" color={cycle === 'annual' ? theme.colorWhite : theme.colorTextSecondary}>
                    Annual
                  </Typography.Body>
                  {maxAnnualSavings > 0 && (
                    <SavingsBadge $selected={cycle === 'annual'}>
                      <Typography.Caption
                        weight="bold"
                        color={cycle === 'annual' ? theme.colorWhite : theme.color.success.main}
                      >
                        {maxAnnualSavings}% off
                      </Typography.Caption>
                    </SavingsBadge>
                  )}
                </Row>
              </CycleTab>
            </CycleToggleTrack>

            <Column gap={12}>
              {plans?.map((plan) => {
                const cta = resolveCta(plan, cycle, sub?.plan.code, currentDisplayOrder);
                const cycleOption = plan.pricing.find((o) => o.billing_cycle === cycle);
                const monthlyOption = plan.pricing.find((o) => o.billing_cycle === 'monthly');
                const annualSavings =
                  cycle === 'annual' && cycleOption && monthlyOption
                    ? monthlyOption.amount * 12 - cycleOption.amount
                    : null;

                return (
                  <PlanCard key={plan.plan_name} $highlight={plan.is_recommended}>
                    {plan.is_recommended && (
                      <Row
                        align="center"
                        justify="space-between"
                        style={{ marginBottom: theme.sizing.small }}
                      >
                        <Row align="center" gap={6}>
                          <LucideIcon name="Star" size={14} color={theme.color.primary.main} />
                          <Typography.Overline color={theme.color.primary.main} weight="bold">
                            RECOMMENDED
                          </Typography.Overline>
                        </Row>
                        <RecommendedPill>
                          <Typography.Caption weight="bold" color={theme.color.primary.main}>
                            Best value
                          </Typography.Caption>
                        </RecommendedPill>
                      </Row>
                    )}

                    <Row align="center" justify="space-between">
                      <Typography.Subtitle weight="bold">{plan.display_name}</Typography.Subtitle>
                      <Row align="baseline" gap={4}>
                        <Typography.H3 weight="bold">
                          {cycleOption ? formatMajor(cycleOption.amount, cycleOption.currency) : formatMajor(0, currency)}
                        </Typography.H3>
                        <Typography.Caption type="secondary">
                          {cycleOption ? (cycleOption.billing_cycle === 'annual' ? '/yr' : '/mo') : 'forever'}
                        </Typography.Caption>
                      </Row>
                    </Row>

                    {cycle === 'annual' && cycleOption && (
                      <Row justify="flex-end">
                        <Typography.Caption type="secondary">
                          {formatMajor(Math.round(cycleOption.amount / 12), cycleOption.currency)}/mo billed annually
                          {annualSavings && annualSavings > 0
                            ? ` · Save ${formatMajor(annualSavings, cycleOption.currency)}/yr`
                            : ''}
                        </Typography.Caption>
                      </Row>
                    )}

                    {!!plan.short_description && (
                      <Typography.Caption type="secondary" style={{ marginTop: 2 }}>
                        {plan.short_description}
                      </Typography.Caption>
                    )}

                    {plan.feature_highlights.length > 0 && (
                      <Row wrap="wrap" gap={8} style={{ marginTop: theme.sizing.medium }}>
                        {plan.feature_highlights.map((highlight) => (
                          <Row key={highlight} align="center" gap={6} width="47%">
                            <LucideIcon name="Check" size={14} color={theme.color.success?.main} />
                            <Typography.Caption style={{ flexShrink: 1 }}>{highlight}</Typography.Caption>
                          </Row>
                        ))}
                      </Row>
                    )}

                    {cta.kind !== 'none' && (
                      <View style={{ marginTop: theme.sizing.medium }}>
                        {cta.kind === 'current' ? (
                          <CurrentPlanBar align="center" justify="center" gap={6}>
                            <LucideIcon name="Check" size={14} color={theme.color.primary.main} />
                            <Typography.Body weight="bold" color={theme.color.primary.main}>
                              Current plan
                            </Typography.Body>
                          </CurrentPlanBar>
                        ) : cta.kind === 'upgrade' ? (
                          <UpgradeButton onPress={() => startCheckout(plan, cta.option, 'upgrade')} activeOpacity={0.88}>
                            <Typography.Body weight="bold" color={theme.colorWhite}>
                              Upgrade to {plan.display_name}
                            </Typography.Body>
                            <LucideIcon name="ArrowRight" size={16} color={theme.colorWhite} />
                          </UpgradeButton>
                        ) : (
                          <DowngradeButton onPress={() => startCheckout(plan, cta.option, 'downgrade')} activeOpacity={0.88}>
                            <Typography.Body weight="bold" color={theme.color.primary.main}>
                              Downgrade to {plan.display_name}
                            </Typography.Body>
                          </DowngradeButton>
                        )}
                      </View>
                    )}
                  </PlanCard>
                );
              })}
            </Column>

            {plans && plans.length > 0 && (
              <Column gap={10}>
                <Typography.Subtitle weight="bold">Compare plans</Typography.Subtitle>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <ComparisonTable>
                    <Row>
                      <ComparisonLabelCell>
                        <Typography.Overline type="secondary">LIMIT</Typography.Overline>
                      </ComparisonLabelCell>
                      {plans.map((plan) => (
                        <ComparisonCell key={plan.plan_name}>
                          <Typography.Overline weight="bold">
                            {plan.display_name.toUpperCase()}
                          </Typography.Overline>
                        </ComparisonCell>
                      ))}
                    </Row>
                    {COMPARISON_ROWS.map((row) => (
                      <ComparisonRow key={row.key}>
                        <ComparisonLabelCell>
                          <Typography.Caption>{row.label}</Typography.Caption>
                        </ComparisonLabelCell>
                        {plans.map((plan) => (
                          <ComparisonCell key={plan.plan_name}>
                            <Typography.Caption weight="semiBold">
                              {formatLimit(plan.entitlements[row.key])}
                            </Typography.Caption>
                          </ComparisonCell>
                        ))}
                      </ComparisonRow>
                    ))}
                    {featureRows.map((row) => (
                      <ComparisonRow key={row.key}>
                        <ComparisonLabelCell>
                          <Typography.Caption>{row.label}</Typography.Caption>
                        </ComparisonLabelCell>
                        {plans.map((plan) => (
                          <ComparisonCell key={plan.plan_name}>
                            <LucideIcon
                              name={plan.features[row.key] ? 'Check' : 'Minus'}
                              size={16}
                              color={plan.features[row.key] ? theme.color.success?.main : theme.colorTextTertiary}
                            />
                          </ComparisonCell>
                        ))}
                      </ComparisonRow>
                    ))}
                  </ComparisonTable>
                </ScrollView>
              </Column>
            )}

            <Row
              align="center"
              justify="center"
              gap={16}
              wrap="wrap"
              style={{ paddingTop: theme.sizing.small }}
            >
              <TrustItem iconName="RefreshCw" label="Cancel anytime" />
              <TrustItem iconName="ShieldCheck" label="Secure payments" />
              <TrustItem iconName="Receipt" label="GST invoice" />
            </Row>
          </Column>
          )}
        </ScreenStateRenderer>
      </ScrollView>
    </AppLayout>
  );
}

// ─── Billing cycle toggle ────────────────────────────────────────────────────

const CycleToggleTrack = styled(Row)`
  background-color: ${({ theme }) => theme.colorBgLayout};
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  padding: ${({ theme }) => theme.sizing.xxSmall}px;
  gap: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const CycleTab = styled.TouchableOpacity<{ $selected: boolean }>`
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: ${({ theme }) => theme.sizing.small}px;
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
  background-color: ${({ theme, $selected }) => ($selected ? theme.color.primary.main : 'transparent')};
  ${({ theme, $selected }) => ($selected ? theme.shadow.sm : '')}
`;

const SavingsBadge = styled(View)<{ $selected: boolean }>`
  background-color: ${({ theme, $selected }) => ($selected ? theme.overlay.onDark20 : theme.color.success.bg)};
  border-radius: ${({ theme }) => theme.borderRadius.small}px;
  padding: 2px 6px;
`;

// ─── Recommended badge ──────────────────────────────────────────────────────

const RecommendedPill = styled(View)`
  background-color: ${({ theme }) => theme.color.primary.bg};
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  padding: 5px 12px;
`;

// ─── Plan cards ─────────────────────────────────────────────────────────────

const PlanCard = styled(View)<{ $highlight?: boolean }>`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  border-width: ${({ theme, $highlight }) => ($highlight ? 1.5 : theme.borderWidth.thin)}px;
  border-color: ${({ theme, $highlight }) => ($highlight ? theme.color.primary.main : theme.colorBorder)};
  padding: ${({ theme }) => theme.sizing.medium}px;
`;

const CurrentPlanBar = styled(Row)`
  background-color: ${({ theme }) => theme.color.primary.bgActive};
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
  padding: ${({ theme }) => theme.sizing.small}px;
`;

const UpgradeButton = styled.TouchableOpacity`
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background-color: ${({ theme }) => theme.color.primary.main};
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
  padding: 13px;
`;

const DowngradeButton = styled.TouchableOpacity`
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.color.primary.border};
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
  padding: 13px;
`;

// ─── Compare limits table ───────────────────────────────────────────────────

const ComparisonTable = styled(View)`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  overflow: hidden;
`;

const ComparisonRow = styled(Row)`
  border-top-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-top-color: ${({ theme }) => theme.colorBorderSecondary};
`;

const ComparisonLabelCell = styled(View)`
  width: 140px;
  padding: ${({ theme }) => theme.sizing.small}px ${({ theme }) => theme.sizing.medium}px;
  justify-content: center;
  background-color: ${({ theme }) => theme.colorBgLayout};
`;

const ComparisonCell = styled(View)`
  width: 96px;
  padding: ${({ theme }) => theme.sizing.small}px ${({ theme }) => theme.sizing.medium}px;
  align-items: center;
  justify-content: center;
`;