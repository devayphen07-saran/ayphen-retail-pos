import React, { FC } from "react";
import { TouchableOpacityProps } from "react-native";
import styled from "styled-components/native";
import { iconButtonVariant, IconButtonVariant } from "./style";
import { LucideIcon, LucideIconNameType } from "../lucide-icon";
import { useMobileTheme, useBreakpoint } from "@ayphen/mobile-theme";

export interface IconButtonProps extends TouchableOpacityProps {
  iconName?: LucideIconNameType;
  iconElement?: React.ReactNode;
  label?: string;
  size?: number;
  backgroundColor?: string;
  /** Overrides the variant-derived icon color (e.g. a neutral icon on a ghost button). */
  color?: string;
  variant?: IconButtonVariant;
}

export const IconButton: FC<IconButtonProps> = ({
  iconName,
  iconElement,
  label,
  size: sizeProp,
  backgroundColor,
  color,
  variant = "primary",
  disabled,
  accessibilityRole,
  accessibilityLabel,
  accessibilityState,
  ...rest
}) => {
  const { theme } = useMobileTheme();
  const { scale } = useBreakpoint();
  const size = sizeProp ?? Math.round(40 * scale);

  const iconColor = color ?? (variant === "primary" ? theme.colorWhite : theme.colorPrimary);

  return (
    <ButtonContainer
      activeOpacity={0.7}
      disabled={disabled}
      $size={size}
      $backgroundColor={backgroundColor}
      $variant={variant}
      accessibilityRole={accessibilityRole ?? "button"}
      accessibilityLabel={accessibilityLabel ?? label ?? iconName}
      accessibilityState={{ disabled, ...accessibilityState }}
      {...rest}
    >
      {iconName && <LucideIcon name={iconName} size={size * 0.6} color={iconColor} />}
      {iconElement}
      {label && <Label>{label}</Label>}
    </ButtonContainer>
  );
};

/* ---------------------------------- */
/* Styled components                   */
/* ---------------------------------- */

const ButtonContainer = styled.TouchableOpacity<{
  $size: number;
  $backgroundColor?: string;
  $variant: IconButtonVariant;
}>`
  ${({ $variant, theme, $backgroundColor }) => iconButtonVariant[$variant](theme, $backgroundColor)}

  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  border-radius: ${({ theme }) => theme.borderRadius.regular}px;

  align-items: center;
  justify-content: center;
  flex-direction: row;

  opacity: ${({ disabled }) => (disabled ? 0.6 : 1)};
`;

const Label = styled.Text`
  margin-left: ${({ theme }) => theme.sizing.xSmall}px;
  font-size: ${({ theme }) => theme.fontSize.small}px;
  color: ${({ theme }) => theme.colorText};
`;

export default IconButton;
