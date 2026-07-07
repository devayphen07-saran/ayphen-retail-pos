import { ActivityIndicator, View } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, LucideIcon, Typography } from '@ayphen/mobile-ui-components';

/** Waiting on POST /checkout to return a Razorpay order — a single blocking
 *  step, not a list, so the generic row-skeleton (`SkeletonLoader`) never fit
 *  here; this reflects what's actually happening (one order being created). */
export function CheckoutLoadingState() {
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
