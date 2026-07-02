import React from "react";
import { Pressable, StyleProp, ViewStyle } from "react-native";
import styled from "styled-components/native";
import { useMobileTheme } from "@nks/mobile-theme";

import { LucideIcon } from "../lucide-icon";
import { Typography } from "../typography";

export interface QueuedMutationCounterProps {
  count: number;
  /** Optional "Retry now" handler that triggers a manual flush. */
  onRetry?: () => void;
  /** Tap handler for the whole row (e.g. open the sync issues screen). */
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

export const QueuedMutationCounter: React.FC<QueuedMutationCounterProps> = ({
  count,
  onRetry,
  onPress,
  style,
}) => {
  const { theme } = useMobileTheme();
  if (count <= 0) return null;

  const label = `${count} pending change${count === 1 ? "" : "s"}`;

  const body = (
    <Container style={style} accessibilityRole={onPress ? "button" : "summary"}>
      <LucideIcon
        name="UploadCloud"
        size={16}
        color={theme.color.warning.text}
      />
      <Text>{label}</Text>
      {onRetry ? (
        <RetryPressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry pending changes"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <RetryText>Retry</RetryText>
        </RetryPressable>
      ) : null}
    </Container>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
        {body}
      </Pressable>
    );
  }
  return body;
};

const Container = styled.View`
  flex-direction: row;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.xSmall}px;
  padding-vertical: ${({ theme }) => theme.sizing.xSmall}px;
  padding-horizontal: ${({ theme }) => theme.sizing.small}px;
  background-color: ${({ theme }) => theme.color.warning.bg};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.color.warning.border};
`;

const Text = styled(Typography.Caption)`
  flex: 1;
  color: ${({ theme }) => theme.color.warning.text};
  font-family: ${({ theme }) => theme.fontFamily.poppinsMedium};
`;

const RetryPressable = styled(Pressable)`
  padding-vertical: ${({ theme }) => theme.sizing.xxSmall}px;
  padding-horizontal: ${({ theme }) => theme.sizing.xSmall}px;
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
  background-color: ${({ theme }) => theme.color.warning.main};
`;

const RetryText = styled(Typography.Caption)`
  color: ${({ theme }) => theme.color.warning.onMain};
  font-family: ${({ theme }) => theme.fontFamily.poppinsMedium};
`;

export default QueuedMutationCounter;
