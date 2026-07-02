import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, ScrollView, Text, TouchableOpacity, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import styled from 'styled-components/native';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { router } from 'expo-router';
import { useMobileTheme } from '@nks/mobile-theme';
import { Column, Input, LucideIcon, Row, Typography } from '@nks/mobile-ui-components';
import {
  useRequestLoginOtpMutation,
  useRequestSignupOtpMutation,
} from '@ayphen-retail/api-manager';
import { phoneSchema, DEFAULT_PHONE_VALUES, type PhoneForm } from '../../features/auth/schema';
import { handleFormError } from '../../utils/handleFormError';

type Mode = 'login' | 'signup';

const TERMS_URL = 'https://ayphen.com/terms';
const PRIVACY_URL = 'https://ayphen.com/privacy';
const W50 = 'rgba(255,255,255,0.50)';
const W55 = 'rgba(255,255,255,0.55)';

/** Step 1 — enter phone, request an OTP for login or signup. */
export default function PhoneScreen() {
  const [mode, setMode] = useState<Mode>('login');
  const { theme } = useMobileTheme();
  const { width: SW, height: SH } = useWindowDimensions();

  const formData = useForm<PhoneForm>({
    resolver: zodResolver(phoneSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: DEFAULT_PHONE_VALUES,
  });
  const {
    control,
    handleSubmit,
    setError,
    formState: { isSubmitting, errors },
  } = formData;
  const serverError = (errors as typeof errors & { root?: { serverError?: { message: string } } })
    .root?.serverError?.message;

  const loginOtp = useRequestLoginOtpMutation();
  const signupOtp = useRequestSignupOtpMutation();

  const onSubmit = async ({ phone }: PhoneForm) => {
    const trimmed = phone.trim();
    try {
      const mut = mode === 'login' ? loginOtp : signupOtp;
      const res = await mut.mutateAsync({ bodyParam: { phone: trimmed } });
      router.push({
        pathname: '/(auth)/otp',
        params: { phone: trimmed, mode, otpRequestId: res.otp_request_id },
      });
    } catch (err) {
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
                <Typography.Caption color={W50}>Enterprise POS Platform</Typography.Caption>
              </Column>
            </Header>

            <Hero>
              <Typography.Overline color={theme.colorAccentLavender}>SIGN IN</Typography.Overline>
              <Gap $h={6} />
              <Typography.H1 color={theme.colorWhite}>
                {mode === 'login' ? 'Welcome\nback.' : 'Create your\naccount.'}
              </Typography.H1>
              <Gap $h={8} />
              <Typography.Body color={W55}>
                {mode === 'login'
                  ? 'Enter your phone number to receive a one-time passcode.'
                  : "We'll text you a 6-digit code to get started."}
              </Typography.Body>
            </Hero>

            <Card style={{ minHeight: SH * 0.5 }}>
              <Input<PhoneForm>
                name="phone"
                control={control}
                label="Phone number"
                inputDataType="phoneNumber"
                placeholder="98765 43210"
                autoFocus
                returnKeyType="done"
                onSubmitEditing={handleSubmit(onSubmit)}
                accessibilityLabel="Phone number"
                prefix={
                  <CountryPrefix>
                    <Text style={{ fontSize: theme.fontSize.large, lineHeight: 22 }}>🇮🇳</Text>
                    <PrefixDivider />
                    <Text
                      style={{
                        fontSize: theme.fontSize.small,
                        fontWeight: '600',
                        color: theme.colorText,
                        letterSpacing: 0.2,
                      }}
                    >
                      +91
                    </Text>
                  </CountryPrefix>
                }
              />

              {serverError ? <ErrorText>{serverError}</ErrorText> : null}

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
                      <LucideIcon name="Send" size={18} color={theme.colorWhite} />
                    )}
                    <Typography.Body weight="semiBold" color={theme.colorWhite}>
                      {isSubmitting ? 'Sending…' : 'Send verification code'}
                    </Typography.Body>
                  </Row>
                </LinearGradient>
              </CtaBtn>

              <SwitchModeBtn
                onPress={() => setMode(mode === 'login' ? 'signup' : 'login')}
                disabled={isSubmitting}
                activeOpacity={0.7}
              >
                <Typography.Caption color={theme.colorPrimary} weight="semiBold">
                  {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Log in'}
                </Typography.Caption>
              </SwitchModeBtn>

              <Disclaimer>
                <Typography.Caption color={theme.colorTextSecondary}>By continuing you agree to our </Typography.Caption>
                <TouchableOpacity onPress={() => void Linking.openURL(TERMS_URL)} activeOpacity={0.7}>
                  <Typography.Caption color={theme.colorPrimary} weight="semiBold">
                    Terms
                  </Typography.Caption>
                </TouchableOpacity>
                <Typography.Caption color={theme.colorTextSecondary}> and </Typography.Caption>
                <TouchableOpacity onPress={() => void Linking.openURL(PRIVACY_URL)} activeOpacity={0.7}>
                  <Typography.Caption color={theme.colorPrimary} weight="semiBold">
                    Privacy Policy
                  </Typography.Caption>
                </TouchableOpacity>
              </Disclaimer>
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

const CountryPrefix = styled.View`
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding-right: ${({ theme }) => theme.sizing.xSmall}px;
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

const ErrorText = styled.Text`
  color: ${({ theme }) => theme.colorError};
  font-size: ${({ theme }) => theme.fontSize.small}px;
  margin-top: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const SwitchModeBtn = styled.TouchableOpacity`
  align-items: center;
  margin-top: ${({ theme }) => theme.sizing.medium}px;
`;

const Disclaimer = styled.View`
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  margin-top: ${({ theme }) => theme.sizing.medium}px;
  gap: 2px;
`;
