import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TouchableOpacity,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import styled from 'styled-components/native';
import { router } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { LucideIcon, Row, Column, Typography } from '@ayphen/mobile-ui-components';
import { useUpdateAccountModeMutation, type AccountMode } from '@ayphen/api-manager';
import { useAuthStore } from '@features/auth/authStore';

const W50 = 'rgba(255,255,255,0.50)';
const W55 = 'rgba(255,255,255,0.55)';

/** First business/personal choice after login — `last_account_mode` was null
 *  (mobile-03 §3c/3d). Re-routing after this always auto-routes to the chosen
 *  mode; nothing forces the chooser again. */
export function ModeSelectScreen() {
  const { theme } = useMobileTheme();
  const { width: SW, height: SH } = useWindowDimensions();
  const updateMode = useUpdateAccountModeMutation();
  const [pending, setPending] = useState<AccountMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPending = pending !== null;

  const handleSelect = async (mode: AccountMode) => {
    if (isPending) return;
    setPending(mode);
    setError(null);
    try {
      await updateMode.mutateAsync({ bodyParam: { mode } });
      useAuthStore.getState().setAccountMode(mode);
      router.replace('/(app)');
    } catch (err) {
      setError((err as { message?: string })?.message ?? 'Could not set your account type.');
      setPending(null);
    }
  };

  return (
    <Root edges={['top']}>
      <BgGrad
        colors={theme.gradient.brandHero}
        locations={[0, 0.55, 1]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        pointerEvents="none"
      />
      <Orb1 pointerEvents="none" style={{ width: SW * 0.72, height: SW * 0.72, top: -SW * 0.22, right: -SW * 0.18 }} />
      <Orb2 pointerEvents="none" style={{ width: SW * 0.48, height: SW * 0.48, top: SH * 0.14, left: -SW * 0.18 }} />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Header>
            <LogoBox>
              <LucideIcon name="Store" size={20} color={theme.colorWhite} />
            </LogoBox>
            <Column gap={1}>
              <Typography.Body weight="semiBold" color={theme.colorWhite}>
                Ayphen Retail
              </Typography.Body>
              <Typography.Caption color={W50}>
                Enterprise POS Platform
              </Typography.Caption>
            </Column>
          </Header>

          <Hero>
            <Typography.Overline color={theme.colorAccentLavender}>
              ACCOUNT TYPE
            </Typography.Overline>
            <Gap $h={6} />
            <Typography.H1 color={theme.colorWhite}>
              {'How will you\nuse Ayphen?'}
            </Typography.H1>
            <Gap $h={8} />
            <Typography.Body color={W55}>
              Pick how you want to start. You can switch anytime from Settings.
            </Typography.Body>
          </Hero>

          <Card>
            <ModeCard
              icon="Store"
              accentBg={theme.color.primary.bg}
              accentIcon={theme.colorPrimary}
              title="Business"
              description="Run a store, track sales, manage staff and inventory."
              selected={pending === 'business'}
              loading={isPending && pending === 'business'}
              disabled={isPending && pending !== 'business'}
              onPress={() => handleSelect('business')}
            />

            <Gap $h={12} />

            <ModeCard
              icon="User"
              accentBg={theme.color.warning.bg}
              accentIcon={theme.colorWarning}
              title="Personal"
              description="Track personal expenses and budgets."
              selected={pending === 'personal'}
              loading={isPending && pending === 'personal'}
              disabled={isPending && pending !== 'personal'}
              onPress={() => handleSelect('personal')}
            />

            {error ? (
              <ErrorRow>
                <LucideIcon name="TriangleAlert" size={14} color={theme.colorError} />
                <Typography.Caption color={theme.colorError}>
                  {error}
                </Typography.Caption>
              </ErrorRow>
            ) : null}

            <Disclaimer>
              <Typography.Caption color={theme.color.grey.borderActive}>
                You can switch anytime from{' '}
              </Typography.Caption>
              <Typography.Caption color={theme.colorPrimary} weight="semiBold">
                Settings
              </Typography.Caption>
            </Disclaimer>
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Root>
  );
}

// ── ModeCard sub-component ────────────────────────────────────────────────────

interface ModeCardProps {
  icon: 'Store' | 'User';
  accentBg: string;
  accentIcon: string;
  title: string;
  description: string;
  selected: boolean;
  loading: boolean;
  disabled: boolean;
  onPress: () => void;
}

function ModeCard({
  icon,
  accentBg,
  accentIcon,
  title,
  description,
  selected,
  loading,
  disabled,
  onPress,
}: ModeCardProps) {
  const { theme } = useMobileTheme();
  return (
    <CardBtn
      onPress={onPress}
      activeOpacity={0.82}
      disabled={disabled}
      $selected={selected}
      accessibilityRole="button"
      accessibilityLabel={`${title}: ${description}`}
      accessibilityState={{ disabled, busy: loading }}
    >
      <Row align="center" gap={14}>
        <IconTile style={{ backgroundColor: accentBg }}>
          <LucideIcon name={icon} size={24} color={accentIcon} />
        </IconTile>

        <CardTextCol>
          <Typography.Body weight="semiBold" color={theme.colorText}>
            {title}
          </Typography.Body>
          <Typography.Caption color={theme.color.grey.active}>{description}</Typography.Caption>
        </CardTextCol>

        {loading ? (
          <ActivityIndicator color={theme.colorPrimary} size="small" />
        ) : selected ? (
          <LucideIcon name="CheckCircle" size={20} color={theme.colorPrimary} />
        ) : (
          <LucideIcon name="ChevronRight" size={20} color={theme.colorTextQuaternary} />
        )}
      </Row>
    </CardBtn>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const Root = styled(SafeAreaView)`
  flex: 1;
  background-color: ${({ theme }) => theme.colorBgContainer};
`;

const BgGrad = styled(LinearGradient)`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
`;

const Orb1 = styled.View`
  position: absolute;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  background-color: ${({ theme }) => theme.gradient.orbIndigo};
  opacity: 0.18;
`;

const Orb2 = styled.View`
  position: absolute;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  background-color: ${({ theme }) => theme.gradient.orbViolet};
  opacity: 0.15;
`;

const Header = styled.View`
  flex-direction: row;
  align-items: center;
  padding-horizontal: ${({ theme }) => theme.sizing.large}px;
  padding-top: ${({ theme }) => theme.sizing.regular}px;
  padding-bottom: ${({ theme }) => theme.sizing.xSmall}px;
  gap: ${({ theme }) => theme.sizing.small}px;
`;

const LogoBox = styled.View`
  width: 40px;
  height: 40px;
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  background-color: ${({ theme }) => theme.overlay.onDark12};
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.overlay.onDark20};
  align-items: center;
  justify-content: center;
`;

const Hero = styled.View`
  padding-horizontal: ${({ theme }) => theme.sizing.large}px;
  padding-top: ${({ theme }) => theme.sizing.xLarge}px;
  padding-bottom: ${({ theme }) => theme.sizing.large}px;
`;

const Gap = styled.View<{ $h: number }>`
  height: ${({ $h }) => $h}px;
`;

const Card = styled.View`
  flex: 1;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-top-left-radius: 28px;
  border-top-right-radius: 28px;
  padding-horizontal: ${({ theme }) => theme.sizing.large}px;
  padding-top: ${({ theme }) => theme.sizing.xLarge}px;
  padding-bottom: ${({ theme }) => theme.sizing.xxLarge}px;
  shadow-color: #000;
  shadow-offset: 0px -6px;
  shadow-opacity: 0.18;
  shadow-radius: 24px;
  elevation: 24;
`;

const CardBtn = styled(TouchableOpacity)<{ $selected: boolean }>`
  flex-direction: row;
  align-items: center;
  padding: ${({ theme }) => theme.sizing.medium}px;
  border-radius: 16px;
  border-width: ${({ theme }) => theme.borderWidth.light}px;
  border-color: ${({ $selected, theme }) => ($selected ? theme.colorPrimary : theme.colorBorder)};
  background-color: ${({ $selected, theme }) => ($selected ? theme.color.primary.bg : theme.color.grey.bg)};
`;

const IconTile = styled.View`
  width: 52px;
  height: 52px;
  border-radius: ${({ theme }) => theme.borderRadius.xxLarge}px;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
`;

const CardTextCol = styled.View`
  flex: 1;
  gap: 3px;
`;

const ErrorRow = styled.View`
  flex-direction: row;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.xSmall}px;
  margin-top: ${({ theme }) => theme.sizing.medium}px;
`;

const Disclaimer = styled.View`
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  margin-top: ${({ theme }) => theme.sizing.large}px;
`;
