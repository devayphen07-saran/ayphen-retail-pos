import React from "react";
import { TouchableOpacity, ViewStyle } from "react-native";
import styled from "styled-components/native";
import { Row } from "../layout";
import { Typography } from "../typography";
import { useMobileTheme } from "@nks/mobile-theme";
import { LucideIcon } from "../lucide-icon";

export interface SectionHeaderProps {
  title: string;
  actionLabel?: string;
  onActionPress?: () => void;
  containerStyle?: ViewStyle;
}

export const SectionHeader: React.FC<SectionHeaderProps> = ({
  title,
  actionLabel = "View all",
  onActionPress,
  containerStyle,
}) => {
  const { theme } = useMobileTheme();

  return (
    <Container style={containerStyle}>
      <Typography.Subtitle weight="semiBold" color={theme.colorText}>
        {title}
      </Typography.Subtitle>
      {onActionPress && (
        <TouchableOpacity onPress={onActionPress} activeOpacity={0.7}>
          <Row gap={"xxSmall"} justify="center" align="center">
            <ActionText weight="medium">
              {actionLabel}
            </ActionText>
            <LucideIcon name="ArrowRight" size={16} color={theme.color.primary.main} />
          </Row>
        </TouchableOpacity>
      )}
    </Container>
  );
};

const Container = styled(Row)`
  justify-content: space-between;
  align-items: center;
  padding-horizontal: ${({ theme }) => theme.padding.small}px;
`;

const ActionText = styled(Typography.Body)`
  font-size: ${({ theme }) => theme.fontSize.small}px;
  color: ${({ theme }) => theme.color.primary.main};
`;