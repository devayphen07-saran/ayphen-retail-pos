import React from 'react';
import { ActivityIndicator, Modal, View } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Typography } from '../typography';

interface OverlayLoaderProps {
  visible: boolean;
  message?: string;
  progress?: number;
}

export const OverlayLoader: React.FC<OverlayLoaderProps> = ({
  visible,
  message = 'Processing...',
  progress,
}) => {
  const { theme } = useMobileTheme();

  return (
    <Modal transparent visible={visible} animationType="fade" statusBarTranslucent>
      <Backdrop>
        <LoaderCard>
          <ActivityIndicator size="large" color={theme.colorPrimary} />
          <Typography.Body weight="semiBold">{message}</Typography.Body>
          {progress !== undefined && (
            <ProgressBarContainer>
              <ProgressBarFill style={{ width: `${Math.min(progress, 100)}%` }} />
            </ProgressBarContainer>
          )}
          <Typography.Caption color={theme.colorTextSecondary}>
            Please don't close the app
          </Typography.Caption>
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

const ProgressBarContainer = styled(View)`
  width: 100%;
  height: ${({ theme }) => theme.sizing.xSmall}px;
  border-radius: ${({ theme }) => theme.borderRadius.small}px;
  background-color: ${({ theme }) => theme.colorBorderSecondary};
  overflow: hidden;
`;

const ProgressBarFill = styled(View)`
  height: 100%;
  border-radius: ${({ theme }) => theme.borderRadius.small}px;
  background-color: ${({ theme }) => theme.color.primary.main};
`;
