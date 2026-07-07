import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  AppLayout,
  Button,
  Column,
  LucideIcon,
  Row,
  ScreenStateRenderer,
  SegmentedTabs,
  Tag,
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
 * Razorpay WebView, no native SDK).
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
            <SegmentedTabs
              items={[
                { key: 'monthly', label: 'Monthly' },
                {
                  key: 'annual',
                  label: maxAnnualSavings > 0 ? `Annual · Save ${maxAnnualSavings}%` : 'Annual',
                },
              ]}
              selectedKey={cycle}
              onChange={(key) => setCycle(key as Cycle)}
            />

            <Column gap={12}>
              {plans?.map((plan) => {
                const cta = resolveCta(plan, cycle, sub?.plan.code, currentDisplayOrder);
                const cycleOption = plan.pricing.find((o) => o.billing_cycle === cycle);

                return (
                  <PlanCard key={plan.plan_name} $variant={cta.kind === 'current' ? 'current' : plan.is_recommended ? 'recommended' : 'default'}>
                    {plan.is_recommended && cta.kind !== 'current' && (
                      <Row align="center" gap={4} style={{ marginBottom: theme.sizing.xSmall }}>
                        <LucideIcon name="Star" size={14} color={theme.color.violet?.main} />
                        <Typography.Overline color={theme.color.violet?.main} weight="bold">
                          MOST POPULAR
                        </Typography.Overline>
                      </Row>
                    )}

                    <Typography.Subtitle weight="bold">{plan.display_name}</Typography.Subtitle>
                    {!!plan.short_description && (
                      <Typography.Caption type="secondary">{plan.short_description}</Typography.Caption>
                    )}

                    <Row align="baseline" gap={8} style={{ marginTop: theme.sizing.small }}>
                      <Typography.H2 weight="bold">
                        {cycleOption ? formatPrice(cycleOption) : `${formatMajor(0, 'INR')} forever`}
                      </Typography.H2>
                      {cycleOption && cycleOption.savings_percentage > 0 && (
                        <Tag label={`Save ${cycleOption.savings_percentage}%`} variant="success" size="sm" />
                      )}
                    </Row>

                    {plan.feature_highlights.length > 0 && (
                      <Column gap={6} style={{ marginTop: theme.sizing.medium }}>
                        {plan.feature_highlights.map((highlight) => (
                          <Row key={highlight} align="center" gap={8}>
                            <LucideIcon name="Check" size={14} color={theme.color.success?.main} />
                            <Typography.Caption>{highlight}</Typography.Caption>
                          </Row>
                        ))}
                      </Column>
                    )}

                    <View style={{ marginTop: theme.sizing.medium }}>
                      {cta.kind === 'current' ? (
                        <CurrentPlanBar align="center" justify="center" gap={6}>
                          <LucideIcon name="Check" size={14} color={theme.color.primary.main} />
                          <Typography.Caption weight="bold" color={theme.color.primary.main}>
                            Current Plan
                          </Typography.Caption>
                        </CurrentPlanBar>
                      ) : cta.kind !== 'none' ? (
                        <Button
                          label={cta.kind === 'upgrade' ? 'Upgrade' : 'Downgrade'}
                          variant={cta.kind === 'upgrade' ? 'primary' : 'default'}
                          onPress={() => startCheckout(plan, cta.option, cta.kind)}
                        />
                      ) : null}
                    </View>
                  </PlanCard>
                );
              })}
            </Column>

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

const PlanCard = styled(View)<{ $variant: 'default' | 'current' | 'recommended' }>`
  background-color: ${({ theme, $variant }) =>
    $variant === 'current' ? theme.color.primary.bg : theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  border-width: ${({ theme, $variant }) => ($variant === 'default' ? theme.borderWidth.thin : 1.5)}px;
  border-color: ${({ theme, $variant }) =>
    $variant === 'current'
      ? theme.color.primary.main
      : $variant === 'recommended'
        ? theme.color.violet?.main
        : theme.colorBorder};
  padding: ${({ theme }) => theme.sizing.medium}px;
`;

const CurrentPlanBar = styled(Row)`
  background-color: ${({ theme }) => theme.color.primary.bgActive};
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
  padding: ${({ theme }) => theme.sizing.small}px;
`;

