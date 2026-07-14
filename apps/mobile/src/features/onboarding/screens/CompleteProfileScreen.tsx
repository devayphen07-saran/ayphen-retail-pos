import { useEffect } from 'react';
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
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  Avatar,
  Button,
  Column,
  Input,
  LucideIcon,
  Row,
  Typography,
} from '@ayphen/mobile-ui-components';
import {
  useProfileQuery,
  useUpdateProfileMutation,
  type UpdateProfileRequest,
} from '@ayphen/api-manager';
import { useAuthStore } from '@store';
import { useAuth } from '@core/providers/AuthProvider';
import { handleFormError } from '../../../utils/handleFormError';
import { onValidationError } from '../../../utils/onValidationError';

const AVATAR_SIZE = 88;

/** Stable reference so ScrollView's contentContainerStyle isn't rebuilt inline every render. */
const SCROLL_CONTENT_STYLE = { flexGrow: 1 };

const completeProfileSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(100),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
});
type CompleteProfileForm = z.infer<typeof completeProfileSchema>;

/** "Asha Rao" → "AR", "asha" → "A" — same rule as ProfileScreen's initialsFrom. */
function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Post-login gate for a missing email (AppGate, `!profileComplete &&
 * !profileGateAcknowledged`) — every signup is phone+OTP only, so email is
 * the one field that can be permanently missing (profile-flow design).
 * Visually matches ModeSelectScreen (gradient hero + rounded bottom-sheet
 * card) — the two screens are the same "first post-login stop, no back
 * button" class, so they share the same chrome: brand header, logout escape
 * hatch (a user signed into the wrong account needs a way out here too), a
 * hero headline, and a card that slides up for the actual content.
 *
 * Skippable, not a hard lock — email is optional at the DB level
 * (email-or-phone), so this is a nudge the user can dismiss for the rest of
 * the session, re-asked on their next login if still incomplete.
 *
 * The photo control is presentation-only — same reason ProfileScreen's is
 * still absent: no attachment/storage upload infra exists yet. Tapping it
 * says so instead of pretending to work.
 */
export function CompleteProfileScreen() {
  const { theme } = useMobileTheme();
  const { width: SW, height: SH } = useWindowDimensions();
  const { logout } = useAuth();
  const updateProfile = useUpdateProfileMutation();
  const { data: profile } = useProfileQuery();

  const {
    control,
    handleSubmit,
    setError,
    reset,
    formState: { isSubmitting },
  } = useForm<CompleteProfileForm>({
    resolver: zodResolver(completeProfileSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { name: '', email: '' },
  });

  // Name is always already set at this point (signup requires it) — prefill
  // it as soon as it loads so the user is only really filling in email.
  useEffect(() => {
    if (profile) reset({ name: profile.name, email: profile.email ?? '' });
  }, [profile, reset]);

  const liveName = useWatch({ control, name: 'name' });

  const onSubmit = async (values: CompleteProfileForm) => {
    try {
      const body: UpdateProfileRequest = { name: values.name, email: values.email };
      await updateProfile.mutateAsync({ bodyParam: body });
      useAuthStore.getState().setProfileComplete();
      router.replace('/(app)');
    } catch (err) {
      handleFormError(err, setError, 'Could not save your profile.');
    }
  };

  const handleSkip = () => {
    useAuthStore.getState().acknowledgeProfileGate();
    router.replace('/(app)');
  };

  const handlePhotoTap = () => {
    Alert.info('Coming soon', 'Profile photo upload will be available in a future update.');
  };

  // Same escape hatch ModeSelectScreen added — no back, no other way out of
  // the first post-login stop for someone signed into the wrong account.
  const handleLogout = () => {
    Alert.confirm(
      'Log out',
      'You will need to sign in again to access your account.',
      () => {
        void logout();
      },
      'Log out',
      'destructive',
    );
  };

  const submit = handleSubmit(onSubmit, onValidationError);

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
          </HeaderRow>

          <HeroTextColumn $extraBottom={AVATAR_SIZE / 2}>
            <Typography.Overline color={theme.colorAccentLavender}>
              YOUR PROFILE
            </Typography.Overline>
            <Gap $h={theme.sizing.xxSmall} />
            <Typography.H1 color={theme.colorWhite}>
              {'Complete your\nprofile'}
            </Typography.H1>
            <Gap $h={theme.sizing.xSmall} />
            <Typography.Body color={theme.overlay.onDark55}>
              Add your email so we can use it for receipts, account recovery,
              and important updates.
            </Typography.Body>
          </HeroTextColumn>

          <Card>
            <AvatarWrap>
              <Avatar
                initials={initialsFrom(liveName || profile?.name || '')}
                size={AVATAR_SIZE}
                showBorder
                borderWidth={3}
                borderColor={theme.colorBgContainer}
                onPress={handlePhotoTap}
                accessibilityLabel="Add a profile photo"
                accessibilityHint="Coming soon"
              />
              <PhotoBadge onPress={handlePhotoTap} activeOpacity={0.8}>
                <LucideIcon name="Camera" size={14} color={theme.colorWhite} />
              </PhotoBadge>
            </AvatarWrap>

            <Gap $h={AVATAR_SIZE / 2 + theme.sizing.xSmall} />

            <Column gap={theme.sizing.medium}>
              <Input<CompleteProfileForm>
                name="name"
                control={control}
                label="Display name"
                placeholder="Your name"
                disabled={isSubmitting}
                prefix={<LucideIcon name="User" size={16} color={theme.colorTextTertiary} />}
                returnKeyType="next"
              />
              <Input<CompleteProfileForm>
                name="email"
                control={control}
                label="Email address"
                placeholder="e.g. you@example.com"
                inputDataType="email"
                disabled={isSubmitting}
                prefix={<LucideIcon name="Mail" size={16} color={theme.colorTextTertiary} />}
                returnKeyType="done"
                onSubmitEditing={submit}
              />
            </Column>

            <Gap $h={theme.sizing.large} />

            <Button
              label="Save & Continue"
              variant="primary"
              loading={isSubmitting}
              disabled={isSubmitting}
              onPress={submit}
              accessibilityLabel="Save profile and continue"
            />
            <Gap $h={theme.sizing.small} />
            <Button
              label="Skip for now"
              variant="text"
              disabled={isSubmitting}
              onPress={handleSkip}
              accessibilityLabel="Skip completing profile for now"
            />

            <FooterRow wrap="wrap" align="center" justify="center">
              <LucideIcon name="ShieldCheck" size={13} color={theme.color.grey.borderActive} />
              <Gap2 $w={theme.sizing.xxSmall} />
              <Typography.Caption color={theme.color.grey.borderActive}>
                You can always update this later from Settings
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

const HeroTextColumn = styled(Column)<{ $extraBottom: number }>`
  padding-horizontal: ${({ theme }) => theme.sizing.large}px;
  padding-top: ${({ theme }) => theme.sizing.large}px;
  padding-bottom: ${({ $extraBottom, theme }) => $extraBottom + theme.sizing.large}px;
`;

const FooterRow = styled(Row)`
  margin-top: ${({ theme }) => theme.sizing.large}px;
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

const Gap = styled.View<{ $h: number }>`
  height: ${({ $h }) => $h}px;
`;

const Gap2 = styled.View<{ $w: number }>`
  width: ${({ $w }) => $w}px;
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

const AvatarWrap = styled.View`
  position: absolute;
  top: -${AVATAR_SIZE / 2}px;
  align-self: center;
  width: ${AVATAR_SIZE}px;
  height: ${AVATAR_SIZE}px;
`;

const PhotoBadge = styled.TouchableOpacity`
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 28px;
  height: 28px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme }) => theme.colorPrimary};
  border-width: ${({ theme }) => theme.borderWidth.light}px;
  border-color: ${({ theme }) => theme.colorBgContainer};
`;