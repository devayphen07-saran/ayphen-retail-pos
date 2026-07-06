import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Alert, AppLayout, Column, LucideIcon, OverlayLoader, Typography } from '@ayphen/mobile-ui-components';
import {
  useCheckoutSubscriptionMutation,
  useVerifySubscriptionPaymentMutation,
} from '@ayphen/api-manager';
import type { CheckoutSubscriptionResponse } from '@ayphen/api-manager';
import {
  RazorpayCheckoutWebView,
  type RazorpaySuccessPayload,
} from '@features/subscription';

type Params = { planCode: string };

interface RazorpayOrderFields {
  key:      string;
  order_id: string;
  amount:   number;
  currency: string;
}

/** The checkout response is intentionally open-ended provider fields
 *  (`CheckoutSubscriptionResponse.[key: string]: unknown`) — narrow to exactly
 *  what Razorpay's checkout.js needs, or treat as unusable. */
function asRazorpayOrder(res: CheckoutSubscriptionResponse): RazorpayOrderFields | null {
  const { key, order_id, amount, currency } = res as Partial<RazorpayOrderFields>;
  if (typeof key !== 'string' || typeof order_id !== 'string' || typeof amount !== 'number' || typeof currency !== 'string') {
    return null;
  }
  return { key, order_id, amount, currency };
}

/**
 * POST checkout → render Razorpay's hosted checkout in a WebView → POST verify
 * on success (subscription.md §9). No native Razorpay SDK — see
 * RazorpayCheckoutWebView. `verify()` is synchronous and idempotent, so unlike
 * a "trust the client, wait for a webhook later" flow there's no race to
 * handle here: we block on verify()'s response before treating the payment as
 * final.
 */
export function SubscriptionCheckoutScreen() {
  const { theme } = useMobileTheme();
  const { planCode } = useLocalSearchParams<Params>();
  const checkout = useCheckoutSubscriptionMutation();
  const verify = useVerifySubscriptionPaymentMutation();
  const [order, setOrder] = useState<RazorpayOrderFields | null>(null);
  const [prefill, setPrefill] = useState<{ name: string; contact: string } | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!planCode || started.current) return;
    started.current = true;

    checkout.mutate(
      { bodyParam: { plan_code: planCode } },
      {
        onSuccess: (res) => {
          const fields = asRazorpayOrder(res);
          if (!fields) {
            Alert.info('Checkout unavailable', 'Payment provider did not return a usable order.');
            router.back();
            return;
          }
          setOrder(fields);
          setPrefill(res.prefill);
        },
        onError: () => {
          Alert.info('Checkout failed', "Couldn't start checkout. Please try again.");
          router.back();
        },
      },
    );
    // planCode is read once per screen instance — a change would need a fresh
    // navigation (new order), not a re-run of this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planCode]);

  const handleSuccess = async (payload: RazorpaySuccessPayload) => {
    try {
      await verify.mutateAsync({
        bodyParam: {
          order_id:   payload.razorpay_order_id,
          payment_id: payload.razorpay_payment_id,
          signature:  payload.razorpay_signature,
        },
      });
      Alert.info('Payment successful', 'Your subscription has been updated.');
      router.replace('/(store)/subscription');
    } catch {
      Alert.info(
        'Verification failed',
        'Payment was received but could not be verified. Contact support if this persists.',
      );
      router.back();
    }
  };

  const handleDismiss = () => router.back();

  const handleFailure = (reason: string | undefined) => {
    Alert.info('Payment failed', reason ?? 'Your payment could not be completed.');
    router.back();
  };

  // Razorpay's hosted checkout.js renders its own header (back arrow wired to
  // `modal.ondismiss` → onDismiss below, plus a language toggle) — once the
  // WebView is up, our own header would just be a second, redundant back
  // button stacked above theirs. Only show ours while there's nothing else
  // on screen to navigate away from (i.e. before the order exists yet).
  if (!order || !prefill) {
    return (
      <AppLayout title="Checkout" onBack={() => router.back()}>
        <CheckoutLoadingState />
      </AppLayout>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colorBgContainer }} edges={['top']}>
      <RazorpayCheckoutWebView
        keyId={order.key}
        orderId={order.order_id}
        amount={order.amount}
        currency={order.currency}
        prefill={prefill}
        onSuccess={handleSuccess}
        onDismiss={handleDismiss}
        onFailure={handleFailure}
      />
      {/* Razorpay's modal closes the instant it hands us the payment result,
          leaving the WebView blank while we finalize. verify() is the critical,
          irreversible step — block interaction behind an overlay so the user
          can't background/back out mid-confirmation (loading-agent.md §3). */}
      <OverlayLoader visible={verify.isPending} message="Confirming payment…" />
    </SafeAreaView>
  );
}

/** Waiting on POST /checkout to return a Razorpay order — a single blocking
 *  step, not a list, so the generic row-skeleton (`SkeletonLoader`) never fit
 *  here; this reflects what's actually happening (one order being created). */
function CheckoutLoadingState() {
  const { theme } = useMobileTheme();
  return (
    <Wrapper>
      <IconSlot>
        <LucideIcon name="ShieldCheck" size={22} color={theme.color.primary.main} />
      </IconSlot>
      <ActivityIndicator size="small" color={theme.color.primary.main} />
      <Column gap={4} style={{ alignItems: 'center' }}>
        <Typography.Body weight="semiBold">Preparing secure checkout</Typography.Body>
        <Typography.Caption type="secondary">This only takes a moment</Typography.Caption>
      </Column>
    </Wrapper>
  );
}

const Wrapper = styled(View)`
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: ${({ theme }) => theme.sizing.medium}px;
  padding: ${({ theme }) => theme.sizing.large}px;
`;

const IconSlot = styled(View)`
  width: 52px;
  height: 52px;
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme }) => theme.color.primary.bg};
`;
