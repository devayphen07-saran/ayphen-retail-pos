import React from 'react';
import { View } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@nks/mobile-theme';
import { Typography } from '../typography';
import { Button } from '../button';
import { LucideIcon } from '../lucide-icon';

interface ScreenStateRendererProps<T> {
  isLoading: boolean;
  isError: boolean;
  error?: string;
  data: T[] | T | null | undefined;
  skeleton: React.ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: { label: string; onPress: () => void };
  onRetry?: () => void;
  children: (data: NonNullable<T[] | T>) => React.ReactNode;
}

export function ScreenStateRenderer<T>({
  isLoading,
  isError,
  error,
  data,
  skeleton,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  emptyAction,
  onRetry,
  children,
}: ScreenStateRendererProps<T>) {
  const hasData = Array.isArray(data) ? data.length > 0 : data != null;
  const { theme } = useMobileTheme();

  if (isLoading && !hasData) return <>{skeleton}</>;

  if (isError && !hasData) {
    return (
      <CenterContainer>
        <LucideIcon name="AlertTriangle" size={48} color={theme.color.danger.main} />
        <Typography.Body weight="semiBold">Something went wrong</Typography.Body>
        {error ? (
          <Typography.Caption color={theme.colorTextSecondary}>{error}</Typography.Caption>
        ) : null}
        {onRetry ? (
          <Button label="Try Again" variant="default" onPress={onRetry} />
        ) : null}
      </CenterContainer>
    );
  }

  if (!hasData && !isLoading) {
    return (
      <CenterContainer>
        <Typography.Body weight="semiBold">{emptyTitle}</Typography.Body>
        {emptyDescription ? (
          <Typography.Caption color={theme.colorTextSecondary}>
            {emptyDescription}
          </Typography.Caption>
        ) : null}
        {emptyAction ? (
          <Button label={emptyAction.label} onPress={emptyAction.onPress} />
        ) : null}
      </CenterContainer>
    );
  }

  return <>{children(data as NonNullable<T[] | T>)}</>;
}

export default ScreenStateRenderer;

const CenterContainer = styled(View)`
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: ${({ theme }) => theme.sizing.xxLarge}px;
  gap: ${({ theme }) => theme.sizing.small}px;
`;
