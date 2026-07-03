import React from 'react';
import { Pressable, StyleProp, ViewStyle } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';

import { LucideIcon } from '../lucide-icon';
import { Typography } from '../typography';

export interface OfflineBannerProps {
  /**
   * When true the banner is hidden. Callers typically wire this to a
   * `useNetInfo()` `isConnected` flag.
   */
  online?: boolean;
  message?: string;
  /** Optional CTA shown on the right (e.g. "Retry"). */
  actionLabel?: string;
  onActionPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

export const OfflineBanner: React.FC<OfflineBannerProps> = ({
  online = false,
  message = "You're offline. Changes will sync when you reconnect.",
  actionLabel,
  onActionPress,
  style,
}) => {
  const { theme } = useMobileTheme();
  if (online) return null;

  return (
    <Container
      style={style}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <LucideIcon name="WifiOff" size={16} color={theme.color.warning.text} />
      <MessageText numberOfLines={2}>{message}</MessageText>
      {actionLabel && onActionPress ? (
        <ActionButton
          onPress={onActionPress}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
        >
          <ActionLabel>{actionLabel}</ActionLabel>
        </ActionButton>
      ) : null}
    </Container>
  );
};

const Container = styled.View`
  flex-direction: row;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.xSmall}px;
  padding-vertical: ${({ theme }) => theme.sizing.xSmall}px;
  padding-horizontal: ${({ theme }) => theme.sizing.small}px;
  background-color: ${({ theme }) => theme.color.warning.bg};
  border-bottom-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-bottom-color: ${({ theme }) => theme.color.warning.border};
`;

const MessageText = styled(Typography.Caption)`
  flex: 1;
  color: ${({ theme }) => theme.color.warning.text};
`;

const ActionButton = styled(Pressable)`
  padding-vertical: ${({ theme }) => theme.sizing.xxSmall}px;
  padding-horizontal: ${({ theme }) => theme.sizing.xSmall}px;
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
`;

const ActionLabel = styled(Typography.Caption)`
  color: ${({ theme }) => theme.color.warning.textActive};
  font-family: ${({ theme }) => theme.fontFamily.poppinsMedium};
`;

export default OfflineBanner;
