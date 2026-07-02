import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import styled from 'styled-components/native';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { router, useLocalSearchParams } from 'expo-router';
import { useMobileTheme } from '@nks/mobile-theme';
import {
  Column,
  Input,
  LucideIcon,
  OtpInput,
  CheckBox,
  Row,
  Typography,
} from '@nks/mobile-ui-components';
import {
  useVerifyLoginMutation,
  useVerifySignupMutation,
} from '@ayphen-retail/api-manager';
import {
  loginOtpSchema,
  signupOtpSchema,
  DEFAULT_OTP_VERIFY_VALUES,
  type OtpVerifyForm,
} from '../../features/auth/schema';
import { buildDeviceRequest } from '../../auth/deviceRequest';
import { useAuth } from '../../providers/AuthProvider';
import { handleFormError } from '../../utils/handleFormError';

type Params = { phone: string; mode: 'login' | 'signup'; otpRequestId: string };

const TRUST_COLOR = '#4338CA';
const W55 = 'rgba(255,255,255,0.55)';

/** Step 2 — verify OTP (+ name/consent for signup), issue tokens, enter the app. */
export default function OtpScreen() {
  const { phone, mode, otpRequestId } = useLocalSearchParams<Params>();
  const isSignup = mode === 'signup';
  const { login } = useAuth();
  const { theme } = useMobileTheme();
  const { width: SW, height: SH } = useWindowDimensions();

  const verifyLogin = useVerifyLoginMutation();
  const verifySignup = useVerifySignupMutation();

  const formData = useForm<OtpVerifyForm>({
    resolver: zodResolver(isSignup ? signupOtpSchema : loginOtpSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: DEFAULT_OTP_VERIFY_VALUES,
  });
  const {
    control,
    handleSubmit,
    setError,
    formState: { isSubmitting, errors },
  } = formData;
  const serverError = (errors as typeof errors & { root?: { serverError?: { message: string } } })
    .root?.serverError?.message;

  const onSubmit = async (values: OtpVerifyForm) => {
    try {
      const device = await buildDeviceRequest();
      const res = isSignup
        ? await verifySignup.mutateAsync({
            bodyParam: {
              phone,
              otp_code: values.otp,
              otp_request_id: otpRequestId,
              name: values.name,
              consent_given: true,
              device,
            },
          })
        : await verifyLogin.mutateAsync({
            bodyParam: {
              phone,
              otp_code: values.otp,
              otp_request_id: otpRequestId,
              device,
            },
          });

      await login(res);
      router.replace('/(app)');
    } catch (err) {
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
            contentContainerStyle={{ flexGrow: 1 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
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
                <Typography.Caption color="rgba(255,255,255,0.50)">
                  Enterprise POS Platform
                </Typography.Caption>
              </Column>
            </Header>

            <Hero>
              <Typography.Overline color={theme.colorAccentLavender}>VERIFICATION</Typography.Overline>
              <Gap $h={6} />
              <Typography.H1 color={theme.colorWhite}>Check your{'\n'}messages.</Typography.H1>
              <Gap $h={8} />
              <Typography.Body color={W55}>{`6-digit code sent to ${phone}`}</Typography.Body>
            </Hero>

            <Card style={{ minHeight: SH * 0.5 }}>
              <BackBtn onPress={() => router.back()} activeOpacity={0.7} disabled={isSubmitting}>
                <Row align="center" gap={4}>
                  <LucideIcon name="ChevronLeft" size={16} color={theme.colorPrimary} />
                  <Typography.Body color={theme.colorPrimary} weight="semiBold">
                    Change number
                  </Typography.Body>
                </Row>
              </BackBtn>

              <Gap $h={16} />

              <OtpInput<OtpVerifyForm> name="otp" control={control} length={6} />

              {serverError ? <ErrorText>{serverError}</ErrorText> : null}

              {isSignup && (
                <>
                  <Gap $h={16} />
                  <Input<OtpVerifyForm>
                    name="name"
                    control={control}
                    label="Your name"
                    required
                    returnKeyType="done"
                    onSubmitEditing={handleSubmit(onSubmit)}
                    accessibilityLabel="Your name"
                  />
                  <Gap $h={12} />
                  <CheckBox<OtpVerifyForm>
                    name="consent"
                    control={control}
                    label="I agree to the Terms & Privacy Policy"
                  />
                </>
              )}

              <Gap $h={20} />

              <CtaBtn onPress={handleSubmit(onSubmit)} activeOpacity={0.88} disabled={isSubmitting}>
                <LinearGradient
                  colors={isSubmitting ? theme.gradient.ctaDisabled : theme.gradient.cta}
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
                <Typography.Caption color={TRUST_COLOR}>
                  Code expires in 5 minutes · 3 attempts allowed
                </Typography.Caption>
              </OtpNote>
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

const Header = styled.View`
  flex-direction: row;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.small}px;
  padding-horizontal: ${({ theme }) => theme.sizing.large}px;
  padding-top: ${({ theme }) => theme.sizing.large}px;
`;

const LogoBox = styled.View`
  width: 36px;
  height: 36px;
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
  background-color: rgba(255, 255, 255, 0.15);
  align-items: center;
  justify-content: center;
`;

const Hero = styled.View`
  padding-horizontal: ${({ theme }) => theme.sizing.large}px;
  padding-top: ${({ theme }) => theme.sizing.xxLarge}px;
  padding-bottom: ${({ theme }) => theme.sizing.xxLarge}px;
`;

const Gap = styled.View<{ $h: number }>`
  height: ${({ $h }) => $h}px;
`;

const Card = styled.View`
  flex: 1;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-top-left-radius: ${({ theme }) => theme.borderRadius.xxLarge}px;
  border-top-right-radius: ${({ theme }) => theme.borderRadius.xxLarge}px;
  padding: ${({ theme }) => theme.sizing.large}px;
  padding-bottom: ${({ theme }) => theme.sizing.xxLarge}px;
`;

const BackBtn = styled.TouchableOpacity`
  flex-direction: row;
  align-items: center;
  align-self: flex-start;
  padding-vertical: ${({ theme }) => theme.sizing.xSmall}px;
`;

const CtaBtn = styled.TouchableOpacity`
  border-radius: ${({ theme }) => theme.borderRadius.xxLarge}px;
  overflow: hidden;
`;

const ErrorText = styled.Text`
  color: ${({ theme }) => theme.colorError};
  font-size: ${({ theme }) => theme.fontSize.small}px;
  margin-top: ${({ theme }) => theme.sizing.xxSmall}px;
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
