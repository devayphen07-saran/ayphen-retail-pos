import { Flex, Row } from "../../layout";
import { Typography } from "../../typography";
import { TouchableOpacity, TouchableOpacityProps } from "react-native";

import styled, { useTheme } from "styled-components/native";
import { CheckIcon } from "lucide-react-native";

interface ConfigSelectItemProps extends TouchableOpacityProps {
  title: string | undefined;
  isSelected: boolean;
  disabled: boolean;
}

export function ConfigSelectItem(props: ConfigSelectItemProps) {
  const { title, isSelected, disabled, ...touchProps } = props;

  const theme = useTheme();
  return (
    <BaseItemContainer $isSelected={isSelected} {...touchProps}>
      <Row padding={"xxSmall"} justify="space-between" align="center">
        <Row gap={"small"}>
          <Flex>
            <Typography.Subtitle
              style={{
                color: disabled ? theme.colorBorder : theme.colorText,
              }}
              weight={"medium"}
            >
              {title}
            </Typography.Subtitle>
          </Flex>
        </Row>
        {isSelected && <CheckIcon color={theme.colorPrimary} />}
      </Row>
    </BaseItemContainer>
  );
}

const BaseItemContainer = styled(TouchableOpacity)<{ $isSelected: boolean }>`
  margin: ${({ theme }) => theme.sizing.xSmall}px;
  padding: ${({ theme }) =>
    `0px ${theme.sizing.xSmall}px 0px ${theme.sizing.xSmall}px`};
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
`;
