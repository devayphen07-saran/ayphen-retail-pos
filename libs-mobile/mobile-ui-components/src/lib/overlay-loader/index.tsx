import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, View } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Typography } from '../typography';
import { Button } from '../button';
import { LucideIcon } from '../lucide-icon';

interface OverlayLoaderProps {
  visible: boolean;
  message?: string;
  progress?: number;
  /**
   * After this many ms of continuously being visible, swap the spinner for a
   * "taking longer than expected" state. Without this, a hung request traps
   * the user behind this overlay indefinitely — Android hardware back does
   * nothing on a transparent blocking modal unless handled explicitly.
   */
  timeoutMs?: number;
  /**
   * Shown as a "Cancel" action once timed out. Omit when backing out mid-flight
   * would be unsafe (e.g. mid-payment-verification) — the timeout message still
   * appears, but the overlay stays blocking, matching the pre-timeout behavior.
   */
  onCancel?: () => void;
  /** Optional "Retry" action alongside Cancel once timed out. */
  onRetry?: () => void;
}

export const OverlayLoader: React.FC<OverlayLoaderProps> = ({
  visible,
  message = 'Processing...',
  progress,
  timeoutMs,
  onCancel,
  onRetry,
}) => {
  const { theme } = useMobileTheme();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!visible || !timeoutMs) {
      setTimedOut(false);
      return;
    }
    const t = setTimeout(() => setTimedOut(true), timeoutMs);
    return () => clearTimeout(t);
  }, [visible, timeoutMs]);

  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => {
        if (timedOut) onCancel?.();
      }}
    >
      <Backdrop>
        <LoaderCard>
          {timedOut ? (
            <>
              <LucideIcon name="Clock" size={28} color={theme.colorTextSecondary} />
              <CenteredBody weight="semiBold">
                This is taking longer than expected
              </CenteredBody>
              <CenteredCaption color={theme.colorTextSecondary}>
                Check your connection and try again.
              </CenteredCaption>
              {(onCancel || onRetry) && (
                <ActionRow>
                  {onCancel && (
                    <ActionButtonSlot>
                      <Button label="Cancel" variant="default" onPress={onCancel} />
                    </ActionButtonSlot>
                  )}
                  {onRetry && (
                    <ActionButtonSlot>
                      <Button label="Retry" variant="primary" onPress={onRetry} />
                    </ActionButtonSlot>
                  )}
                </ActionRow>
              )}
            </>
          ) : (
            <>
              <ActivityIndicator size="large" color={theme.colorPrimary} />
              <Typography.Body weight="semiBold">{message}</Typography.Body>
              {progress !== undefined && (
                <ProgressBarContainer>
                  <ProgressBarFill $percent={Math.min(progress, 100)} />
                </ProgressBarContainer>
              )}
              <Typography.Caption color={theme.colorTextSecondary}>
                Please don't close the app
              </Typography.Caption>
            </>
          )}
        </LoaderCard>
      </Backdrop>
    </Modal>
  );
};

export default OverlayLoader;

const Backdrop = styled(View)`
  flex: 1;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme }) => theme.overlay.scrim};
`;

const LoaderCard = styled(View)`
  width: 280px;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.medium}px;
  padding: ${({ theme }) => theme.sizing.large}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
`;

const ActionRow = styled(View)`
  flex-direction: row;
  gap: ${({ theme }) => theme.sizing.small}px;
  width: 100%;
`;

const ActionButtonSlot = styled(View)`
  flex: 1;
`;

const ProgressBarContainer = styled(View)`
  width: 100%;
  height: ${({ theme }) => theme.sizing.xSmall}px;
  border-radius: ${({ theme }) => theme.borderRadius.small}px;
  background-color: ${({ theme }) => theme.colorBorderSecondary};
  overflow: hidden;
`;

const ProgressBarFill = styled(View)<{ $percent: number }>`
  height: 100%;
  width: ${({ $percent }) => $percent}%;
  border-radius: ${({ theme }) => theme.borderRadius.small}px;
  background-color: ${({ theme }) => theme.color.primary.main};
`;

const CenteredBody = styled(Typography.Body)`
  text-align: center;
`;

const CenteredCaption = styled(Typography.Caption)`
  text-align: center;
`;
