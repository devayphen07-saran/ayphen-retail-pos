import React from "react";
import { TouchableOpacityProps, ActivityIndicator } from "react-native";
import styled, { DefaultTheme } from "styled-components/native";
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
  accessibilityRole,
  accessibilityLabel,
  accessibilityState,
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
      accessibilityRole={accessibilityRole ?? "button"}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled || loading, busy: loading, ...accessibilityState }}
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
            <ButtonText $size={size} $variant={variant} $color={resolvedTextColor}>
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
  gap: ${({ theme }) => theme.sizing.small}px;
`;

const IconWrapper = styled.View`
  align-items: center;
  justify-content: center;
`;

/* ---------------------------------- */
/* Size configs                        */
/* ---------------------------------- */

// Size ladder resolved from theme tokens. Raw px snapped to the nearest token
// (deltas noted inline where the original value was off the scale).
const sizeConfigs = (
  theme: DefaultTheme,
): Record<
  ButtonSize,
  {
    height: number;
    paddingVertical: number;
    paddingHorizontal: number;
    borderRadius: number;
  }
> => ({
  // heights use the dedicated btnHeight* component tokens (exact, off the spacing
  // scale); padding/radius snap to the spacing/radius scale (pv 2→xxSmall(4, +2)).
  xsm: {
    height: theme.componentSizing.btnHeightXsm,
    paddingVertical: theme.sizing.xxSmall,
    paddingHorizontal: theme.sizing.xSmall,
    borderRadius: theme.borderRadius.small,
  },
  sm: {
    height: theme.componentSizing.btnHeightSm,
    paddingVertical: theme.sizing.xxSmall,
    paddingHorizontal: theme.sizing.small,
    borderRadius: theme.borderRadius.small,
  },
  md: {
    height: theme.componentSizing.btnHeightMd,
    paddingVertical: theme.sizing.xSmall,
    paddingHorizontal: theme.sizing.medium,
    borderRadius: theme.borderRadius.medium,
  },
  // pv 10→small(12, +2)
  lg: {
    height: theme.componentSizing.btnHeightLg,
    paddingVertical: theme.sizing.small,
    paddingHorizontal: theme.sizing.regular,
    borderRadius: theme.borderRadius.regular,
  },
  xlg: {
    height: theme.componentSizing.btnHeightXlg,
    paddingVertical: theme.sizing.small,
    paddingHorizontal: theme.sizing.large,
    borderRadius: theme.borderRadius.large,
  },
});

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

  height: ${({ theme, $size, $scale }) => sizeConfigs(theme)[$size].height * $scale}px;
  border-radius: ${({ theme, $size, $scale }) => sizeConfigs(theme)[$size].borderRadius * $scale}px;
  padding-top: ${({ theme, $size, $scale }) => sizeConfigs(theme)[$size].paddingVertical * $scale}px;
  padding-bottom: ${({ theme, $size, $scale }) => sizeConfigs(theme)[$size].paddingVertical * $scale}px;
  padding-left: ${({ theme, $size, $scale }) => sizeConfigs(theme)[$size].paddingHorizontal * $scale}px;
  padding-right: ${({ theme, $size, $scale }) => sizeConfigs(theme)[$size].paddingHorizontal * $scale}px;

  ${({ $borderColor, theme }) =>
    $borderColor
      ? `
    border-color: ${$borderColor};
    border-width: ${theme.borderWidth.thin}px;
  `
      : ""}
`;

const ButtonText = styled(Typography.Subtitle)<{
  $variant: ButtonVariant;
  $size: ButtonSize;
  $color?: string;
}>`
  ${({ $variant, theme }) => buttonTextVariant[$variant](theme)}
  letter-spacing: 0.5px;
  ${({ $color }) => ($color ? `color: ${$color};` : "")}
`;

export default Button;
