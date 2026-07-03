import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleProp, ViewStyle } from "react-native";
import styled from "styled-components/native";
import { useMobileTheme } from "@ayphen/mobile-theme";

import { LucideIcon } from "../lucide-icon";
import { Typography } from "../typography";

export interface RetryButtonProps {
  onRetry: () => void;
  loading?: boolean;
  disabled?: boolean;
  label?: string;
  attempts?: number;
  /** Epoch ms after which the retry is allowed. While in the future, the
   * button shows a countdown and stays disabled. */
  nextRetryAtMs?: number | null;
  style?: StyleProp<ViewStyle>;
}

export const RetryButton: React.FC<RetryButtonProps> = ({
  onRetry,
  loading = false,
  disabled = false,
  label = "Retry",
  attempts,
  nextRetryAtMs,
  style,
}) => {
  const { theme } = useMobileTheme();
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!nextRetryAtMs || nextRetryAtMs <= Date.now()) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [nextRetryAtMs]);

  const cooldown =
    nextRetryAtMs != null && nextRetryAtMs > Date.now()
      ? Math.ceil((nextRetryAtMs - Date.now()) / 1000)
      : 0;

  const isDisabled = disabled || loading || cooldown > 0;
  const buttonLabel = cooldown > 0 ? `Retry in ${cooldown}s` : label;
  const accessibilityLabel =
    attempts != null
      ? `${buttonLabel}, attempt ${attempts + 1}`
      : buttonLabel;

  return (
    <Container
      onPress={onRetry}
      disabled={isDisabled}
      style={style}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      accessibilityLabel={accessibilityLabel}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
    >
      {loading ? (
        <ActivityIndicator color={theme.colorPrimary} size="small" />
      ) : (
        <LucideIcon name="RefreshCw" size={14} color={theme.colorPrimary} />
      )}
      <Label>{buttonLabel}</Label>
      {attempts != null && attempts > 0 && cooldown === 0 ? (
        <Sub>
          {attempts} {attempts === 1 ? "try" : "tries"}
        </Sub>
      ) : null}
    </Container>
  );
};

const Container = styled(Pressable)<{ disabled?: boolean }>`
  flex-direction: row;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.xxSmall}px;
  padding-vertical: ${({ theme }) => theme.sizing.xxSmall}px;
  padding-horizontal: ${({ theme }) => theme.sizing.xSmall}px;
  border-radius: ${({ theme }) => theme.borderRadius.regular}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.color.primary.border};
  background-color: ${({ theme }) => theme.color.primary.bg};
  opacity: ${({ disabled }) => (disabled ? 0.5 : 1)};
  align-self: flex-start;
`;

const Label = styled(Typography.Caption)`
  color: ${({ theme }) => theme.color.primary.text};
  font-family: ${({ theme }) => theme.fontFamily.poppinsMedium};
`;

const Sub = styled(Typography.Caption)`
  color: ${({ theme }) => theme.colorTextSecondary};
`;

export default RetryButton;
