import React, { memo, useMemo } from 'react';
import styled from 'styled-components/native';

import { Button } from '../button';
import { LucideIcon, LucideIconNameType } from '../lucide-icon';
import { Typography } from '../typography';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface NoDataButtonProps {
  readonly buttonText: string;
  readonly onPress: () => void;

  readonly variant?:
    | 'primary'
    | 'default'
    | 'dashed'
    | 'text';

  readonly disabled?: boolean;
  readonly loading?: boolean;

  /**
   * Optional stable key.
   * Strongly recommended when rendering multiple buttons.
   */
  readonly key?: string;

  /**
   * Optional accessibility label override.
   */
  readonly accessibilityLabel?: string;

  /**
   * Optional test id.
   */
  readonly testID?: string;
}

export interface NoDataContainerProps {
  readonly message: string;

  readonly description?: string;

  readonly iconName?: LucideIconNameType;

  /**
   * Single or multiple CTA actions.
   */
  readonly buttonProps?:
    | NoDataButtonProps
    | readonly NoDataButtonProps[];

  /**
   * Icon size in px.
   * @default 36
   */
  readonly iconSize?: number;

  /**
   * Optional test id.
   */
  readonly testID?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

function NoDataContainerComponent({
  message,
  description,
  iconName = 'Database',
  buttonProps,
  iconSize = 36,
  testID,
}: NoDataContainerProps) {
  // ───────────────────────────────────────────────────────────────────────────
  // Memoized buttons
  // ───────────────────────────────────────────────────────────────────────────

  const buttons = useMemo<readonly NoDataButtonProps[]>(() => {
    if (!buttonProps) {
      return [];
    }

    return Array.isArray(buttonProps)
      ? buttonProps
      : [buttonProps];
  }, [buttonProps]);

  // ───────────────────────────────────────────────────────────────────────────
  // Accessibility label
  // ───────────────────────────────────────────────────────────────────────────

  const accessibilityLabel = useMemo(() => {
    return description
      ? `${message}. ${description}`
      : message;
  }, [message, description]);

  // ───────────────────────────────────────────────────────────────────────────
  // Render
  // ───────────────────────────────────────────────────────────────────────────

  return (
    <Container
      testID={testID}
      accessible
      accessibilityRole="summary"
      accessibilityLabel={accessibilityLabel}
    >
      <IconWrapper
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <LucideIcon
          name={iconName}
          size={iconSize}
        />
      </IconWrapper>

      <Title
        accessibilityRole="header"
        numberOfLines={2}
      >
        {message}
      </Title>

      {!!description && (
        <Description
          type="secondary"
          numberOfLines={4}
        >
          {description}
        </Description>
      )}

      {buttons.length > 0 && (
        <ButtonStack>
          {buttons.map((button, index) => {
            const resolvedVariant =
              button.variant ??
              (index === 0
                ? 'primary'
                : 'default');

            return (
              <ButtonWrapper
                key={
                  button.key ??
                  `${button.buttonText}-${index}`
                }
              >
                <Button
                  variant={resolvedVariant}
                  label={button.buttonText}
                  onPress={button.onPress}
                  disabled={
                    button.disabled ||
                    button.loading
                  }
                  loading={button.loading}
                  accessibilityLabel={
                    button.accessibilityLabel ??
                    button.buttonText
                  }
                  testID={button.testID}
                />
              </ButtonWrapper>
            );
          })}
        </ButtonStack>
      )}
    </Container>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Export Memoized Component
// ─────────────────────────────────────────────────────────────────────────────

export const NoDataContainer = memo(
  NoDataContainerComponent,
);

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const Container = styled.View`
  flex: 1;

  align-items: center;
  justify-content: center;

  padding: ${({ theme }) => theme.sizing.large}px;

  width: 100%;
  max-width: 420px;

  align-self: center;
`;

const IconWrapper = styled.View`
  width: 80px;
  height: 80px;

  border-radius: 20px;

  align-items: center;
  justify-content: center;

  background-color: ${({ theme }) =>
    theme.colorBgContainer};

  margin-bottom: ${({ theme }) =>
    theme.sizing.medium}px;

  ${({ theme }) => theme.shadow.md}
`;

const Title = styled(Typography.Body)`
  text-align: center;

  font-weight: 600;

  margin-bottom: ${({ theme }) =>
    theme.sizing.xSmall}px;

  padding-horizontal: ${({ theme }) =>
    theme.sizing.small}px;
`;

const Description = styled(Typography.Caption)`
  text-align: center;

  margin-bottom: ${({ theme }) =>
    theme.sizing.large}px;

  max-width: 320px;

  line-height: ${({ theme }) => theme.sizing.regular}px;

  padding-horizontal: ${({ theme }) =>
    theme.sizing.small}px;
`;

const ButtonStack = styled.View`
  width: 100%;
  max-width: 280px;
`;

const ButtonWrapper = styled.View`
  margin-bottom: ${({ theme }) =>
    theme.sizing.small}px;
`;