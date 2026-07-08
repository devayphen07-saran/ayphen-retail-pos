import { useEffect } from 'react';
import { View } from 'react-native';
import styled from 'styled-components/native';
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, LucideIcon, Typography } from '@ayphen/mobile-ui-components';

const PULSE_DURATION_MS = 1800;

/** One expanding-and-fading ring, offset by `delayMs` so a second ring can
 *  trail the first — reads as a continuous outward pulse ("verifying...")
 *  instead of one ring blinking on/off. */
function usePulseRingStyle(delayMs: number) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withDelay(
      delayMs,
      withRepeat(
        withTiming(1, { duration: PULSE_DURATION_MS, easing: Easing.out(Easing.ease) }),
        -1,
        false,
      ),
    );
  }, [progress, delayMs]);

  return useAnimatedStyle(() => ({
    opacity: (1 - progress.value) * 0.45,
    transform: [{ scale: 1 + progress.value * 0.7 }],
  }));
}

/** Waiting on POST /checkout to return a Razorpay order — a single blocking
 *  step, not a list, so the generic row-skeleton (`SkeletonLoader`) never fit
 *  here; this reflects what's actually happening (one order being created).
 *  The pulsing shield IS the loading indicator — no separate spinner, so the
 *  "verifying" motif reads as one deliberate element instead of two
 *  unrelated ones stacked on top of each other. */
export function CheckoutLoadingState() {
  const { theme } = useMobileTheme();
  const ring1 = usePulseRingStyle(0);
  const ring2 = usePulseRingStyle(PULSE_DURATION_MS / 2);

  return (
    <Wrapper>
      <Animated.View entering={FadeIn.duration(400)}>
        <Column gap="large" style={{ alignItems: 'center' }}>
          <BadgeWrap>
            <PulseRing style={ring1} />
            <PulseRing style={ring2} />
            <IconSlot>
              <LucideIcon name="ShieldCheck" size={28} color={theme.color.primary.main} />
            </IconSlot>
          </BadgeWrap>
          <Column gap={6} style={{ alignItems: 'center' }}>
            <Typography.H5 weight="semiBold">Preparing secure checkout</Typography.H5>
            <Typography.Body type="secondary" style={{ textAlign: 'center' }}>
              This only takes a moment
            </Typography.Body>
          </Column>
        </Column>
      </Animated.View>
    </Wrapper>
  );
}

const Wrapper = styled(View)`
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: ${({ theme }) => theme.sizing.large}px;
`;

const BadgeWrap = styled(View)`
  width: 96px;
  height: 96px;
  align-items: center;
  justify-content: center;
`;

const PulseRing = styled(Animated.View)`
  position: absolute;
  width: 68px;
  height: 68px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  background-color: ${({ theme }) => theme.color.primary.main};
`;

const IconSlot = styled(View)`
  width: 68px;
  height: 68px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.color.primary.border};
  ${({ theme }) => theme.shadow.md}
`;