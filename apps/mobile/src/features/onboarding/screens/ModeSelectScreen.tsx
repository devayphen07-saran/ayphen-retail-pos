import { useState } from 'react';
import {
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
import {
  Alert,
  LucideIcon,
  Row,
  Column,
  Typography,
} from '@ayphen/mobile-ui-components';
import {
  useUpdateAccountModeMutation,
  type AccountMode,
} from '@ayphen/api-manager';
import { useAuthStore } from '@store';
import { useAuth } from '@core/providers/AuthProvider';
import { ModeCard } from '../components/ModeCard';

/** Stable reference so ScrollView's contentContainerStyle isn't rebuilt inline every render. */
const SCROLL_CONTENT_STYLE = { flexGrow: 1 };

/** First business/personal choice after login — `last_account_mode` was null
 *  (mobile-03 §3c/3d). Re-routing after this always auto-routes to the chosen
 *  mode; nothing forces the chooser again. */
export function ModeSelectScreen() {
  const { theme } = useMobileTheme();
  const { width: SW, height: SH } = useWindowDimensions();
  const { logout } = useAuth();
  const updateMode = useUpdateAccountModeMutation();
  const [pending, setPending] = useState<AccountMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPending = pending !== null;

  const pendingCount = useAuthStore((s) => s.pendingInvitationCount);
  const hasInvites = pendingCount > 0;

  const handleOpenInvitations = () => {
    router.push('/(onboarding)/invitations');
  };

  // A user who signed in with the wrong account had no way out of this
  // screen — no back (it's the first post-login stop) and, unlike the next
  // screen in this same funnel (OnboardingHubScreen), no logout either.
  const handleLogout = () => {
    Alert.confirm(
      'Log out',
      'You will need to sign in again to access your stores.',
      () => {
        void logout();
      },
      'Log out',
      'destructive',
    );
  };

  const handleSelect = async (mode: AccountMode) => {
    if (isPending) return;
    setPending(mode);
    setError(null);
    try {
      await updateMode.mutateAsync({ bodyParam: { mode } });
      useAuthStore.getState().setAccountMode(mode);
      router.replace('/(app)');
    } catch (err) {
      setError(
        (err as { message?: string })?.message ??
          'Could not set your account type.',
      );
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
      <Orb1 pointerEvents="none" $size={SW * 0.72} $top={-SW * 0.22} $right={-SW * 0.18} />
      <Orb2 pointerEvents="none" $size={SW * 0.48} $top={SH * 0.14} $left={-SW * 0.18} />

      <FlexKAV behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={SCROLL_CONTENT_STYLE}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <HeaderRow align="center" justify="space-between">
            <Row align="center" gap={theme.sizing.small}>
              <LogoBox>
                <LucideIcon name="Store" size={20} color={theme.colorWhite} />
              </LogoBox>
              <Column gap={theme.sizing.xxSmall}>
                <Typography.Body weight="semiBold" color={theme.colorWhite}>
                  Ayphen Retail
                </Typography.Body>
                <Typography.Caption color={theme.overlay.onDark50}>
                  Enterprise POS Platform
                </Typography.Caption>
              </Column>
            </Row>

            <Row align="center" gap={theme.sizing.small}>
              <TouchableOpacity
                onPress={handleLogout}
                accessibilityRole="button"
                accessibilityLabel="Log out"
                activeOpacity={0.75}
                hitSlop={8}
              >
                <IconCircle>
                  <LucideIcon name="LogOut" size={20} color={theme.colorWhite} />
                </IconCircle>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleOpenInvitations}
                accessibilityRole="button"
                accessibilityLabel={
                  hasInvites
                    ? `${pendingCount} pending invitation${pendingCount === 1 ? '' : 's'}`
                    : 'Invitations'
                }
                activeOpacity={0.75}
                hitSlop={8}
              >
                <BadgeIconWrap>
                  <IconCircle>
                    <LucideIcon name="Mail" size={20} color={theme.colorWhite} />
                  </IconCircle>

                  {hasInvites ? (
                    <BadgeDot>
                      <BadgeCountText weight={700} color={theme.colorWhite}>
                        {pendingCount > 9 ? '9+' : pendingCount}
                      </BadgeCountText>
                    </BadgeDot>
                  ) : null}
                </BadgeIconWrap>
              </TouchableOpacity>
            </Row>
          </HeaderRow>

          <HeroTextColumn>
            <Typography.Overline color={theme.colorAccentLavender}>
              ACCOUNT TYPE
            </Typography.Overline>
            <Gap $h={theme.sizing.xxSmall} />
            <Typography.H1 color={theme.colorWhite}>
              {'How will you\nuse Ayphen?'}
            </Typography.H1>
            <Gap $h={theme.sizing.xSmall} />
            <Typography.Body color={theme.overlay.onDark55}>
              Pick how you want to start. You can switch anytime from Settings.
            </Typography.Body>
          </HeroTextColumn>

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

            <Gap $h={theme.sizing.small} />

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
              <ErrorRow align="center" gap={theme.sizing.xSmall}>
                <LucideIcon
                  name="TriangleAlert"
                  size={14}
                  color={theme.colorError}
                />
                <Typography.Caption color={theme.colorError}>
                  {error}
                </Typography.Caption>
              </ErrorRow>
            ) : null}

            <FooterRow wrap="wrap" align="center" justify="center">
              <Typography.Caption color={theme.color.grey.borderActive}>
                You can switch anytime from{' '}
              </Typography.Caption>
              <Typography.Caption color={theme.colorPrimary} weight="semiBold">
                Settings
              </Typography.Caption>
            </FooterRow>
          </Card>
        </ScrollView>
      </FlexKAV>
    </Root>
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

const Orb1 = styled.View<{ $size: number; $top: number; $right: number }>`
  position: absolute;
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  top: ${({ $top }) => $top}px;
  right: ${({ $right }) => $right}px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  background-color: ${({ theme }) => theme.gradient.orbIndigo};
  opacity: 0.18;
`;

const Orb2 = styled.View<{ $size: number; $top: number; $left: number }>`
  position: absolute;
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  top: ${({ $top }) => $top}px;
  left: ${({ $left }) => $left}px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  background-color: ${({ theme }) => theme.gradient.orbViolet};
  opacity: 0.15;
`;

const FlexKAV = styled(KeyboardAvoidingView)`
  flex: 1;
`;

const HeaderRow = styled(Row)`
  padding-horizontal: ${({ theme }) => theme.sizing.large}px;
  padding-top: ${({ theme }) => theme.sizing.regular}px;
  padding-bottom: ${({ theme }) => theme.sizing.xSmall}px;
`;

const HeroTextColumn = styled(Column)`
  padding-horizontal: ${({ theme }) => theme.sizing.large}px;
  padding-top: ${({ theme }) => theme.sizing.xLarge}px;
  padding-bottom: ${({ theme }) => theme.sizing.large}px;
`;

const ErrorRow = styled(Row)`
  margin-top: ${({ theme }) => theme.sizing.medium}px;
`;

const FooterRow = styled(Row)`
  margin-top: ${({ theme }) => theme.sizing.large}px;
`;

const BadgeCountText = styled(Typography.Caption)`
  font-size: ${({ theme }) => theme.fontSize.xxSmall}px;
  line-height: 12px;
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

const Gap = styled.View<{ $h: number }>`
  height: ${({ $h }) => $h}px;
`;

const IconCircle = styled.View`
  width: 40px;
  height: 40px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme }) => theme.overlay.onDark12};
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.overlay.onDark20};
`;

const BadgeIconWrap = styled.View`
  position: relative;
`;

const BadgeDot = styled.View`
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 16px;
  height: 16px;
  border-radius: ${({ theme }) => theme.borderRadius.regular}px;
  padding-horizontal: 3px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme }) => theme.colorError};
  border-width: ${({ theme }) => theme.borderWidth.light}px;
  border-color: ${({ theme }) => theme.colorBgContainer};
`;

const Card = styled.View`
  flex: 1;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-top-left-radius: ${({ theme }) => theme.borderRadius.xxLarge * 2}px;
  border-top-right-radius: ${({ theme }) => theme.borderRadius.xxLarge * 2}px;
  padding-horizontal: ${({ theme }) => theme.sizing.large}px;
  padding-top: ${({ theme }) => theme.sizing.xLarge}px;
  padding-bottom: ${({ theme }) => theme.sizing.xxLarge}px;
  ${({ theme }) => theme.shadow.top}
`;
