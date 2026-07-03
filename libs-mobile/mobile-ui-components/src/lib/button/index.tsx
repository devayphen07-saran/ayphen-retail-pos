import React from "react";
import { TouchableOpacityProps, ActivityIndicator } from "react-native";
import styled from "styled-components/native";
import { buttonTextVariant, buttonVariant } from "./style";
import { LucideIcon, LucideIconNameType } from "../lucide-icon";
import { Typography } from "../typography";
import { useMobileTheme, ColorType, useBreakpoint } from "@ayphen/mobile-theme";


type ButtonVariant = "primary" | "default" | "dashed" | "text";
export type ButtonSize = "xsm" | "sm" | "md" | "lg" | "xlg";

interface ButtonProps extends TouchableOpacityProps {
  label?: string;
  loading?: boolean;
  disabled?: boolean;
  size?: ButtonSize;
  variant?: ButtonVariant;
  iconName?: LucideIconNameType;
  iconElement?: React.ReactNode;
  borderColor?: string;
  textColor?: string;
}

export const Button: React.FC<ButtonProps> = ({
  label,
  loading = false,
  disabled = false,
  size = "md",
  variant = "primary",
  iconName,
  iconElement,
  borderColor,
  textColor,
  ...rest
}) => {
  const { theme } = useMobileTheme();
  const { scale } = useBreakpoint();

  const resolvedTextColor = textColor || (variant === "primary" ? theme.colorWhite : undefined);

  const spinnerColor = variant === "primary" ? theme.colorWhite : theme.colorPrimary;
  const iconSize = Math.round(20 * scale);

  return (
    <ButtonContainer
      activeOpacity={0.88}
      disabled={disabled || loading}
      $variant={variant}
      $size={size}
      $scale={scale}
      $borderColor={borderColor}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color={spinnerColor} />
      ) : (
        <RowView>
          {iconName && (
            <LucideIcon
              name={iconName}
              size={iconSize}
              color={resolvedTextColor}
              colorType={variant === "primary" ? undefined : ColorType.primary}
            />
          )}

          {iconElement && <IconWrapper>{iconElement}</IconWrapper>}

          {label && (
            <ButtonText $size={size} $variant={variant} color={resolvedTextColor}>
              {label}
            </ButtonText>
          )}
        </RowView>
      )}
    </ButtonContainer>
  );
};

/* ---------------------------------- */
/* Layout helpers                      */
/* ---------------------------------- */

const RowView = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 10px;
`;

const IconWrapper = styled.View`
  align-items: center;
  justify-content: center;
`;

/* ---------------------------------- */
/* Size configs                        */
/* ---------------------------------- */

const sizeConfigs: Record<
  ButtonSize,
  {
    height?: number;
    paddingVertical: number;
    paddingHorizontal: number;
    borderRadius: number;
  }
> = {
  xsm: { height: 26, paddingVertical: 2, paddingHorizontal: 8, borderRadius: 4 },
  sm: { height: 32, paddingVertical: 4, paddingHorizontal: 12, borderRadius: 4 },
  md: { height: 40, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 6 },
  lg: { height: 48, paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8 },
  xlg: { height: 56, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10 },
};

/* ---------------------------------- */
/* Styled components                   */
/* ---------------------------------- */

const ButtonContainer = styled.TouchableOpacity<{
  $variant: ButtonVariant;
  disabled?: boolean;
  $size: ButtonSize;
  $scale: number;
  $borderColor?: string;
}>`
  ${({ $variant, theme }) => buttonVariant[$variant](theme)}

  flex-direction: row;
  align-items: center;
  justify-content: center;

  opacity: ${({ disabled }) => (disabled ? 0.6 : 1)};

  height: ${({ $size, $scale }) => (sizeConfigs[$size].height ?? 0) * $scale}px;
  border-radius: ${({ $size, $scale }) => sizeConfigs[$size].borderRadius * $scale}px;
  padding-top: ${({ $size, $scale }) => sizeConfigs[$size].paddingVertical * $scale}px;
  padding-bottom: ${({ $size, $scale }) => sizeConfigs[$size].paddingVertical * $scale}px;
  padding-left: ${({ $size, $scale }) => sizeConfigs[$size].paddingHorizontal * $scale}px;
  padding-right: ${({ $size, $scale }) => sizeConfigs[$size].paddingHorizontal * $scale}px;

  ${({ $borderColor }) =>
    $borderColor
      ? `
    border-color: ${$borderColor};
    border-width: 1px;
  `
      : ""}
`;

const ButtonText = styled(Typography.Subtitle)<{
  $variant: ButtonVariant;
  $size: ButtonSize;
  color?: string;
}>`
  ${({ $variant, theme }) => buttonTextVariant[$variant](theme)}
  letter-spacing: 0.5px;
  ${({ color }) => (color ? `color: ${color};` : "")}
`;

export default Button;
