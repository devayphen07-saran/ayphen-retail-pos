import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, TouchableOpacity, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import styled from 'styled-components/native';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  Column,
  Flex,
  LucideIcon,
  OtpInput,
  Row,
  Typography,
} from '@ayphen/mobile-ui-components';
import {
  useRequestLoginOtpMutation,
  useRequestSignupOtpMutation,
  useVerifyLoginMutation,
  useVerifySignupMutation,
  type NormalizedError,
} from '@ayphen/api-manager';
import {
  loginOtpSchema,
  signupOtpSchema,
  DEFAULT_OTP_VERIFY_VALUES,
  normalizeName,
  type OtpVerifyForm,
} from '@features/auth';
import { buildDeviceRequest } from '@core/auth/device-request';
import { useAuth } from '@core/providers/AuthProvider';
import { useAuthStore } from '@store';
import { handleFormError } from '../../utils/handleFormError';
import { onValidationError } from '../../utils/onValidationError';

type Params = {
  phone: string;
  mode: 'login' | 'signup';
  otpRequestId: string;
  /** Seconds until this code expires — from the OTP challenge response. */
  expiresIn: string;
  /** Signup only — collected + validated on the phone screen, forwarded here. */
  name?: string;
};

function formatExpiryNote(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return `Code expires in ${minutes} minute${minutes === 1 ? '' : 's'} · 3 attempts allowed`;
}

/** Step 2 — verify OTP, issue tokens, enter the app. Name + consent come from
 *  step 1 (phone screen); signup sends them at verify time. */
export default function OtpScreen() {
  const { phone, mode, otpRequestId, expiresIn, name } = useLocalSearchParams<Params>();
  const isSignup = mode === 'signup';
  const { login } = useAuth();
  const { theme } = useMobileTheme();
  const { width: SW, height: SH } = useWindowDimensions();

  const verifyLogin = useVerifyLoginMutation();
  const verifySignup = useVerifySignupMutation();
  const requestLoginOtp = useRequestLoginOtpMutation();
  const requestSignupOtp = useRequestSignupOtpMutation();

  const formData = useForm<OtpVerifyForm>({
    resolver: zodResolver(isSignup ? signupOtpSchema : loginOtpSchema),
    // onBlur: a field validates when the user leaves it, so an untouched
    // form never shows a red error on mount (forms-agent.md §4).
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: DEFAULT_OTP_VERIFY_VALUES,
  });
  const {
    control,
    handleSubmit,
    setError,
    reset,
    formState: { isSubmitting, dirtyFields },
  } = formData;
  const hasUnsavedChanges = Object.keys(dirtyFields).length > 0;
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null);
  // The request id issued when the code was (re)sent — mutable because
  // resending gets a fresh one from the server; verify must use the latest.
  const [currentOtpRequestId, setCurrentOtpRequestId] = useState(otpRequestId);
  const [resendSecondsLeft, setResendSecondsLeft] = useState(30);
  const [isResending, setIsResending] = useState(false);
  const [codeExpirySeconds, setCodeExpirySeconds] = useState(Number(expiresIn) || 300);

  useEffect(() => {
    if (resendSecondsLeft <= 0) return;
    const t = setTimeout(() => setResendSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendSecondsLeft]);

  const handleResend = async () => {
    setIsResending(true);
    try {
      const mut = isSignup ? requestSignupOtp : requestLoginOtp;
      const res = await mut.mutateAsync({ bodyParam: { phone } });
      setCurrentOtpRequestId(res.otp_request_id);
      setCodeExpirySeconds(res.expires_in);
      setAttemptsRemaining(null);
      reset(DEFAULT_OTP_VERIFY_VALUES);
      setResendSecondsLeft(30);
      Alert.info('Code sent', `A new code was sent to ${phone}.`);
    } catch {
      Alert.info('Error', "Couldn't resend the code. Check your connection and try again.");
    } finally {
      setIsResending(false);
    }
  };

  const onSubmit = async (values: OtpVerifyForm) => {
    try {
      const device = await buildDeviceRequest();
      const res = isSignup
        ? await verifySignup.mutateAsync({
            bodyParam: {
              phone,
              otp_code: values.otp,
              otp_request_id: currentOtpRequestId,
              name: normalizeName(name ?? ''),
              consent_given: true,
              device,
            },
          })
        : await verifyLogin.mutateAsync({
            bodyParam: {
              phone,
              otp_code: values.otp,
              otp_request_id: currentOtpRequestId,
              device,
            },
          });

      await login(res);
      // reset() before navigating away (forms-agent.md §6) — the OTP screen
      // stays mounted underneath the replace target briefly during transition.
      reset();
      // Resume the deep-link / expired-session target AuthGate stashed; the
      // target's own layout guards still run, so an unauthorized resume
      // redirects safely. Fall back to the default entry gate.
      const returnTo = useAuthStore.getState().consumePendingReturnTo();
      router.replace(returnTo ? (returnTo as Href) : '/(app)');
    } catch (err) {
      // The code the user typed is wrong/expired/reused — that's about the
      // OTP field itself, so it belongs inline under the input (same call the
      // phone screen makes for phone-scoped errors), not a popup. Everything
      // else (rate limit, offline, unknown) has no single field to blame —
      // the shared handler's alert is the right surface for those.
      const e = err as Partial<NormalizedError>;
      const OTP_VALUE_CODES = new Set(['OTP_INVALID', 'OTP_EXPIRED', 'OTP_ALREADY_CONSUMED']);
      if (e?.status === 422 && (e.code ?? '').toUpperCase() === 'OTP_MAX_ATTEMPTS') {
        // No attempts left on this code — the input is now dead. Send the
        // user back to request a fresh one instead of leaving them staring
        // at a 6-digit field that can never succeed.
        Alert.info('Too many attempts', 'Too many incorrect attempts. Request a new code.');
        router.back();
        return;
      }
      if (e?.status === 422 && OTP_VALUE_CODES.has((e.code ?? '').toUpperCase())) {
        const remaining = (e.data as { details?: { attemptsRemaining?: number } } | undefined)?.details
          ?.attemptsRemaining;
        if (typeof remaining === 'number') setAttemptsRemaining(remaining);
        setError('otp', { type: 'server', message: e.message ?? "That code isn't right." });
        return;
      }
      handleFormError(err, setError, 'Could not verify the code.');
    }
  };

  return (
    <FormProvider {...formData}>
      <Root edges={['top']}>
        <BgGrad
          colors={theme.gradient.brandHero}
          locations={[0, 0.55, 1]}
          start={{ x: 0.1, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          pointerEvents="none"
          style={{ height: SH * 0.55 }}
        />
        <Orb1
          pointerEvents="none"
          style={{ top: SH * 0.05, right: -SW * 0.25, width: SW * 0.65, height: SW * 0.65, borderRadius: SW * 0.325 }}
        />
        <Orb2
          pointerEvents="none"
          style={{ top: SH * 0.12, left: -SW * 0.3, width: SW * 0.7, height: SW * 0.7, borderRadius: SW * 0.35 }}
        />

        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView
            contentContainerStyle={{ flexGrow: 1, paddingBottom: 80 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            showsVerticalScrollIndicator={false}
          >
            <Row
              align="center"
              gap="small"
              style={{
                paddingHorizontal: theme.sizing.large,
                paddingTop: theme.sizing.large,
              }}
            >
              <LogoBox>
                <LucideIcon name="Store" size={20} color={theme.colorWhite} />
              </LogoBox>
              <Column gap={1}>
                <Typography.Body weight="semiBold" color={theme.colorWhite}>
                  Ayphen Retail
                </Typography.Body>
                <Typography.Caption color={theme.overlay.onDark50}>
                  Enterprise POS Platform
                </Typography.Caption>
              </Column>
            </Row>

            <Column
              style={{
                paddingHorizontal: theme.sizing.large,
                paddingVertical: theme.sizing.xxLarge,
              }}
            >
              <Typography.Overline color={theme.colorAccentLavender}>VERIFICATION</Typography.Overline>
              <Flex height={6} />
              <Typography.H1 color={theme.colorWhite}>Check your{'\n'}messages.</Typography.H1>
              <Flex height={8} />
              <Typography.Body color={theme.overlay.onDark55}>{`6-digit code sent to ${phone}`}</Typography.Body>
            </Column>

            <Card style={{ minHeight: SH * 0.5 }}>
              <TouchableOpacity
                onPress={() => router.back()}
                activeOpacity={0.7}
                disabled={isSubmitting}
                accessibilityRole="button"
                accessibilityLabel="Change phone number"
                style={{ alignSelf: 'flex-start', paddingVertical: theme.sizing.xSmall }}
              >
                <Row align="center" gap={theme.sizing.xxSmall}>
                  <LucideIcon name="ChevronLeft" size={18} color={theme.colorPrimary} />
                  <Typography.Body weight="semiBold" color={theme.colorPrimary}>
                    Change number
                  </Typography.Body>
                </Row>
              </TouchableOpacity>

              <Flex height={16} />

              <OtpInput<OtpVerifyForm>
                name="otp"
                control={control}
                length={6}
                disabled={isSubmitting}
              />

              <Flex height={20} />

              <CtaBtn
                onPress={handleSubmit(onSubmit, onValidationError)}
                activeOpacity={0.88}
                disabled={!hasUnsavedChanges || isSubmitting}
                accessibilityLabel={
                  isSubmitting ? 'Verifying' : isSignup ? 'Create account' : 'Verify and sign in'
                }
                accessibilityState={{ disabled: !hasUnsavedChanges || isSubmitting, busy: isSubmitting }}
              >
                <LinearGradient
                  colors={!hasUnsavedChanges || isSubmitting ? theme.gradient.ctaDisabled : theme.gradient.cta}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={{
                    height: theme.componentSizing.ctaBtnHeight,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: theme.borderRadius.xxLarge,
                  }}
                >
                  <Row gap={10} align="center" justify="center">
                    {isSubmitting ? (
                      <ActivityIndicator color={theme.colorWhite} size="small" />
                    ) : (
                      <LucideIcon name="ShieldCheck" size={18} color={theme.colorWhite} />
                    )}
                    <Typography.Body weight="semiBold" color={theme.colorWhite}>
                      {isSubmitting ? 'Verifying…' : isSignup ? 'Create account' : 'Verify & Sign in'}
                    </Typography.Body>
                  </Row>
                </LinearGradient>
              </CtaBtn>

              <OtpNote>
                <LucideIcon name="Clock" size={12} color={theme.colorPrimaryHover} />
                <Typography.Caption color={theme.colorTrustNote}>
                  {attemptsRemaining != null
                    ? `${attemptsRemaining} attempt${attemptsRemaining === 1 ? '' : 's'} left`
                    : formatExpiryNote(codeExpirySeconds)}
                </Typography.Caption>
              </OtpNote>

              <ResendRow
                onPress={handleResend}
                disabled={resendSecondsLeft > 0 || isResending || isSubmitting}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Resend code"
                accessibilityState={{ disabled: resendSecondsLeft > 0 || isResending || isSubmitting }}
              >
                <Typography.Caption color={theme.colorTextSecondary}>
                  Didn't get a code?{' '}
                </Typography.Caption>
                <Typography.Caption
                  weight="semiBold"
                  color={resendSecondsLeft > 0 ? theme.colorTextTertiary : theme.colorPrimary}
                >
                  {isResending
                    ? 'Sending…'
                    : resendSecondsLeft > 0
                      ? `Resend in 0:${String(resendSecondsLeft).padStart(2, '0')}`
                      : 'Resend code'}
                </Typography.Caption>
              </ResendRow>
            </Card>
          </ScrollView>
        </KeyboardAvoidingView>
      </Root>
    </FormProvider>
  );
}

// ── Styled components ─────────────────────────────────────────────────────────

const Root = styled(SafeAreaView)`
  flex: 1;
  background-color: ${({ theme }) => theme.colorBgContainer};
`;

const BgGrad = styled(LinearGradient)`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
`;

const Orb1 = styled.View`
  position: absolute;
  background-color: ${({ theme }) => theme.overlay.onDark06};
`;

const Orb2 = styled.View`
  position: absolute;
  background-color: ${({ theme }) => theme.overlay.onDark04};
`;

const LogoBox = styled.View`
  width: ${({ theme }) => theme.componentSizing.heroBrandIconSize}px;
  height: ${({ theme }) => theme.componentSizing.heroBrandIconSize}px;
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
  background-color: ${({ theme }) => theme.overlay.onDark15};
  align-items: center;
  justify-content: center;
`;

const Card = styled.View`
  flex: 1;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-top-left-radius: ${({ theme }) => theme.borderRadius.xxLarge}px;
  border-top-right-radius: ${({ theme }) => theme.borderRadius.xxLarge}px;
  padding: ${({ theme }) => theme.sizing.large}px;
  padding-bottom: ${({ theme }) => theme.sizing.xxLarge}px;
`;

const CtaBtn = styled.TouchableOpacity`
  border-radius: ${({ theme }) => theme.borderRadius.xxLarge}px;
  overflow: hidden;
`;

const OtpNote = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: ${({ theme }) => theme.sizing.medium}px;
  padding: ${({ theme }) => theme.sizing.xSmall}px;
  background-color: ${({ theme }) => theme.color.primary.bg};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
`;

const ResendRow = styled.TouchableOpacity`
  flex-direction: row;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: ${({ theme }) => theme.sizing.medium}px;
  padding-vertical: ${({ theme }) => theme.sizing.xxSmall}px;
`;
