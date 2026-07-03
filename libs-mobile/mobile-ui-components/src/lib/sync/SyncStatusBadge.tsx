import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleProp,
  ViewStyle,
} from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';

import { LucideIcon } from '../lucide-icon';
import { Typography } from '../typography';
import { SyncStatus, SYNC_STATUS_VISUALS } from './types';

export interface SyncStatusBadgeProps {
  status: SyncStatus;
  /** Override the auto-derived label (e.g. "3 pending" instead of "Pending"). */
  label?: string;
  onPress?: () => void;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}

export const SyncStatusBadge: React.FC<SyncStatusBadgeProps> = ({
  status,
  label,
  onPress,
  compact = false,
  style,
}) => {
  const { theme } = useMobileTheme();
  const visual = SYNC_STATUS_VISUALS[status];
  const tone = theme.color[visual.tone];
  const text = label ?? visual.label;

  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (status !== 'syncing') {
      spin.stopAnimation();
      spin.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [status, spin]);

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const content = (
    <Pill $bg={tone.bg} $border={tone.border} $compact={compact} style={style}>
      <Animated.View
        style={{ transform: status === 'syncing' ? [{ rotate }] : [] }}
      >
        <LucideIcon
          name={visual.iconName}
          size={compact ? 12 : 14}
          color={tone.text}
        />
      </Animated.View>
      {!compact && <Label $color={tone.text}>{text}</Label>}
    </Pill>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`Sync status: ${text}`}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        {content}
      </Pressable>
    );
  }
  return content;
};

const Pill = styled.View<{ $bg: string; $border: string; $compact: boolean }>`
  flex-direction: row;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.xxSmall}px;
  padding-vertical: ${({ theme, $compact }) =>
    $compact ? theme.sizing.xxSmall : theme.sizing.xSmall}px;
  padding-horizontal: ${({ theme, $compact }) =>
    $compact ? theme.sizing.xxSmall : theme.sizing.xSmall}px;
  /* border-radius: 999px — intentionally a pill shape, no token equivalent */
  border-radius: 999px;
  background-color: ${({ $bg }) => $bg};
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ $border }) => $border};
  align-self: flex-start;
`;

const Label = styled(Typography.Caption)<{ $color: string }>`
  color: ${({ $color }) => $color};
  font-family: ${({ theme }) => theme.fontFamily.poppinsMedium};
`;

export default SyncStatusBadge;