import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  TouchableOpacity,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import styled from 'styled-components/native';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { router } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  CheckBox,
  Column,
  Flex,
  Input,
  LucideIcon,
  Row,
  Typography,
} from '@ayphen/mobile-ui-components';
import {
  useRequestLoginOtpMutation,
  useRequestSignupOtpMutation,
} from '@ayphen/api-manager';
import {
  loginPhoneSchema,
  signupPhoneSchema,
  DEFAULT_PHONE_VALUES,
  normalizePhone,
  normalizeName,
  type PhoneForm,
} from '@features/auth';
import { handleFormError } from '../../utils/handleFormError';
import { onValidationError } from '../../utils/onValidationError';

type Mode = 'login' | 'signup';

const TERMS_URL = 'https://ayphen.com/terms';
const PRIVACY_URL = 'https://ayphen.com/privacy';
const W50 = 'rgba(255,255,255,0.50)';
const W55 = 'rgba(255,255,255,0.55)';

/** Step 1 — enter phone, request an OTP for login or signup. */
export default function PhoneScreen() {
  const [mode, setMode] = useState<Mode>('login');
  const isSignup = mode === 'signup';
  const { theme } = useMobileTheme();
  const { width: SW, height: SH } = useWindowDimensions();

  const formData = useForm<PhoneForm>({
    resolver: zodResolver(isSignup ? signupPhoneSchema : loginPhoneSchema),
    // onBlur: a field validates when the user leaves it, so an untouched
    // empty form never shows a red error on mount (forms-agent.md §4).
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: DEFAULT_PHONE_VALUES,
  });
  const {
    control,
    handleSubmit,
    setError,
    clearErrors,
    setFocus,
    reset,
    formState: { isSubmitting, dirtyFields },
  } = formData;
  const hasUnsavedChanges = Object.keys(dirtyFields).length > 0;

  const loginOtp = useRequestLoginOtpMutation();
  const signupOtp = useRequestSignupOtpMutation();

  // Login and signup are treated as separate forms — switching mode clears
  // every value and error (not just the phone field) so nothing typed or
  // errored in one mode leaks into the other.
  const switchMode = () => {
    reset(DEFAULT_PHONE_VALUES);
    setMode((m) => (m === 'login' ? 'signup' : 'login'));
  };

  // The mode switch mounts a newly-autoFocused field (name for signup, phone
  // for login), which steals native focus from whatever was previously
  // focused and fires a blur on it. With mode:'onTouched' that incidental
  // blur — not real user interaction — validates the just-reset empty field
  // and shows a premature error. Clear it once the switch has settled.
  useEffect(() => {
    clearErrors();
  }, [mode, clearErrors]);

  const onSubmit = async ({ phone, name, marketingOptIn }: PhoneForm) => {
    const trimmed = normalizePhone(phone);
    try {
      const mut = isSignup ? signupOtp : loginOtp;
      const res = await mut.mutateAsync({ bodyParam: { phone: trimmed } });
      router.push({
        pathname: '/(auth)/otp',
        params: {
          phone: trimmed,
          mode,
          otpRequestId: res.otp_request_id,
          ...(isSignup
            ? {
                name: normalizeName(name),
                marketingOptIn: String(marketingOptIn),
              }
            : {}),
        },
      });
      // The phone screen stays mounted underneath (router.push, not replace) —
      // reset so backing out from the OTP screen shows a clean form (forms-agent.md §6).
      reset();
    } catch (err) {
      // Phone-scoped server errors (e.g. "User not found" on login, "already
      // registered" on signup) belong under the phone field, not in a popup —
      // set them on the field so RHF renders them inline via <Input>'s error.
      const e = err as { status?: number; message?: string } | undefined;
      if (e?.status === 400 || e?.status === 401 || e?.status === 409) {
        setError('phone', {
          type: 'server',
          message: e?.message ?? 'Could not send the code.',
        });
        return;
      }
      // Everything else (offline, 5xx, unknown) → the shared handler's alert.
      handleFormError(err, setError, 'Could not send the code.');
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
          style={{
            top: SH * 0.05,
            right: -SW * 0.25,
            width: SW * 0.65,
            height: SW * 0.65,
            borderRadius: SW * 0.325,
          }}
        />
        <Orb2
          pointerEvents="none"
          style={{
            top: SH * 0.12,
            left: -SW * 0.3,
            width: SW * 0.7,
            height: SW * 0.7,
            borderRadius: SW * 0.35,
          }}
        />

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
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
                <Typography.Caption color={W50}>
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
              <Typography.Overline color={theme.colorAccentLavender}>
                SIGN IN
              </Typography.Overline>
              <Flex height={6} />
              <Typography.H1 color={theme.colorWhite}>
                {mode === 'login' ? 'Welcome\nback.' : 'Create your\naccount.'}
              </Typography.H1>
              <Flex height={8} />
              <Typography.Body color={W55}>
                {mode === 'login'
                  ? 'Enter your phone number to receive a one-time passcode.'
                  : "We'll text you a 6-digit code to get started."}
              </Typography.Body>
            </Column>

            <Card style={{ minHeight: SH * 0.5 }}>
              {isSignup && (
                <>
                  <Input<PhoneForm>
                    name="name"
                    control={control}
                    label="Your name"
                    required
                    autoFocus
                    disabled={isSubmitting}
                    returnKeyType="next"
                    onSubmitEditing={() => setFocus('phone')}
                    accessibilityLabel="Your name"
                  />
                </>
              )}

              <Input<PhoneForm>
                name="phone"
                control={control}
                label="Phone number"
                required
                inputDataType="phoneNumber"
                placeholder="98765 43210"
                autoFocus={!isSignup}
                disabled={isSubmitting}
                returnKeyType="done"
                onSubmitEditing={handleSubmit(onSubmit, onValidationError)}
                accessibilityLabel="Phone number"
                prefix={
                  <Row
                    align="center"
                    gap={6}
                    style={{ paddingRight: theme.sizing.xSmall }}
                  >
                    <Typography.H5 style={{ lineHeight: 22 }}>🇮🇳</Typography.H5>
                    <PrefixDivider />
                    <Typography.Body
                      weight="semiBold"
                      color={theme.colorText}
                      style={{ letterSpacing: 0.2 }}
                    >
                      +91
                    </Typography.Body>
                  </Row>
                }
              />

              {isSignup && (
                <>
                  <Flex height={20} />
                  <CheckBox<PhoneForm>
                    name="marketingOptIn"
                    control={control}
                    size={20}
                    containerStyle={{ alignItems: 'flex-start' }}
                    checkboxStyle={{ marginTop: 1 }}
                    label="I agree to receive marketing emails from Ayphen Retail. You can unsubscribe anytime."
                    labelStyle={{
                      fontSize: theme.fontSize.small,
                      color: theme.colorTextSecondary,
                      lineHeight: 20,
                    }}
                    accessibilityHint="Optional. You can change this anytime in settings."
                  />
                </>
              )}

              <Flex height={20} />

              <CtaBtn
                onPress={handleSubmit(onSubmit, onValidationError)}
                activeOpacity={0.88}
                disabled={!hasUnsavedChanges || isSubmitting}
                accessibilityLabel={
                  isSubmitting
                    ? 'Sending'
                    : mode === 'login'
                      ? 'Login'
                      : 'Register'
                }
                accessibilityState={{
                  disabled: !hasUnsavedChanges || isSubmitting,
                  busy: isSubmitting,
                }}
              >
                <LinearGradient
                  colors={
                    !hasUnsavedChanges || isSubmitting
                      ? theme.gradient.ctaDisabled
                      : theme.gradient.cta
                  }
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={{
                    height: 54,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: theme.borderRadius.xxLarge,
                  }}
                >
                  <Row gap={10} align="center" justify="center">
                    {isSubmitting ? (
                      <ActivityIndicator
                        color={theme.colorWhite}
                        size="small"
                      />
                    ) : (
                      <LucideIcon
                        name="Send"
                        size={18}
                        color={theme.colorWhite}
                      />
                    )}
                    <Typography.Body weight="semiBold" color={theme.colorWhite}>
                      {isSubmitting
                        ? 'Sending…'
                        : mode === 'login'
                          ? 'Login'
                          : 'Register'}
                    </Typography.Body>
                  </Row>
                </LinearGradient>
              </CtaBtn>

              <SwitchModeBtn
                onPress={switchMode}
                disabled={isSubmitting}
                activeOpacity={0.7}
                accessibilityLabel={
                  mode === 'login'
                    ? 'New here? Create an account'
                    : 'Already have an account? Log in'
                }
              >
                <Typography.Caption
                  color={theme.colorPrimary}
                  weight="semiBold"
                >
                  {mode === 'login'
                    ? 'New here? Create an account'
                    : 'Already have an account? Log in'}
                </Typography.Caption>
              </SwitchModeBtn>

              <Row
                wrap="wrap"
                align="center"
                justify="center"
                gap={2}
                style={{ marginTop: theme.sizing.medium }}
              >
                <Typography.Caption color={theme.colorTextSecondary}>
                  By continuing you agree to our{' '}
                </Typography.Caption>
                <TouchableOpacity
                  onPress={() => void Linking.openURL(TERMS_URL)}
                  activeOpacity={0.7}
                  accessibilityLabel="Open Terms of Service"
                >
                  <Typography.Caption
                    color={theme.colorPrimary}
                    weight="semiBold"
                  >
                    Terms
                  </Typography.Caption>
                </TouchableOpacity>
                <Typography.Caption color={theme.colorTextSecondary}>
                  {' '}
                  and{' '}
                </Typography.Caption>
                <TouchableOpacity
                  onPress={() => void Linking.openURL(PRIVACY_URL)}
                  activeOpacity={0.7}
                  accessibilityLabel="Open Privacy Policy"
                >
                  <Typography.Caption
                    color={theme.colorPrimary}
                    weight="semiBold"
                  >
                    Privacy Policy
                  </Typography.Caption>
                </TouchableOpacity>
              </Row>
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
  background-color: rgba(255, 255, 255, 0.06);
`;

const Orb2 = styled.View`
  position: absolute;
  background-color: rgba(255, 255, 255, 0.04);
`;

const LogoBox = styled.View`
  width: 36px;
  height: 36px;
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
  background-color: rgba(255, 255, 255, 0.15);
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

const PrefixDivider = styled.View`
  width: 1px;
  height: ${({ theme }) => theme.sizing.medium}px;
  background-color: ${({ theme }) => theme.colorBorder};
`;

const CtaBtn = styled.TouchableOpacity`
  border-radius: ${({ theme }) => theme.borderRadius.xxLarge}px;
  overflow: hidden;
`;

const SwitchModeBtn = styled.TouchableOpacity`
  align-items: center;
  margin-top: ${({ theme }) => theme.sizing.medium}px;
`;

