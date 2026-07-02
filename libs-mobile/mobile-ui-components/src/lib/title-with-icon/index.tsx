import React from "react";
import styled from "styled-components/native";
import { View } from "react-native";
import { Row } from "../layout";
import { LucideIcon, LucideIconNameType } from "../lucide-icon";
import { Typography } from "../typography";

export interface TitleWithIconProps {
  iconName?: LucideIconNameType;
  iconColor?: string;
  title: string;
}

export const TitleWithIcon: React.FC<TitleWithIconProps> = ({
  iconName = "Box",
  iconColor,
  title,
}) => {
  return (
    <IconDetail>
      <Row gap={3} align="center">
        <LucideIcon name={iconName} size={10} color={iconColor} />
        <CaptionText type="secondary">
          {title}
        </CaptionText>
      </Row>
    </IconDetail>
  );
};

const IconDetail = styled(View)`
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  padding: ${({ theme }) =>
    `${theme.sizing.xxSmall}px ${theme.sizing.xSmall}px 0px 0px`};
`;

const CaptionText = styled(Typography.Caption)`
  font-size: ${({ theme }) => theme.fontSize.xxSmall}px;
`;