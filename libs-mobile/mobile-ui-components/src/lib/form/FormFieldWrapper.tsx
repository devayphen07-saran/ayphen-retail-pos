import React from "react";
import { StyleProp, ViewStyle } from "react-native";
import styled from "styled-components/native";
import { useBreakpoint } from "@ayphen/mobile-theme";

import { Typography } from "../typography";
import { inputLabelStyles } from "../input/style";

export interface FormFieldWrapperProps {
  label?: string;
  required?: boolean;
  error?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

export const FormFieldWrapper: React.FC<FormFieldWrapperProps> = ({
  label,
  required = false,
  error,
  disabled = false,
  style,
  children,
}) => {
  const { fontScale } = useBreakpoint();

  return (
    <Wrapper style={[{ opacity: disabled ? 0.6 : 1 }, style]}>
      {label ? (
        <Label
          $fontScale={fontScale}
          accessibilityRole="text"
        >
          {label}
          {required ? <RequiredMark> *</RequiredMark> : null}
        </Label>
      ) : null}

      {children}

      {error ? (
        <ErrorText accessibilityRole="alert" accessibilityLiveRegion="polite">
          {error}
        </ErrorText>
      ) : null}
    </Wrapper>
  );
};

const Wrapper = styled.View`
  width: 100%;
`;

const Label = styled(Typography.Caption)<{ $fontScale: number }>`
  ${({ theme, $fontScale }) => {
    const s = inputLabelStyles(theme);
    return `
      font-size: ${String(Number(s.fontSize) * $fontScale)}px;
      font-weight: ${String(s.fontWeight)};
      color: ${String(s.color)};
      font-family: ${String(s.fontFamily)};
    `;
  }}
  padding-bottom: ${({ theme }) => theme.sizing.xxSmall}px;
  margin-left: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const RequiredMark = styled(Typography.Body)`
  color: ${({ theme }) => theme.color?.red?.main || theme.colorError};
`;

const ErrorText = styled(Typography.Caption)`
  color: ${({ theme }) => theme.color?.red?.main || theme.colorError};
  margin-left: ${({ theme }) => theme.sizing.xxSmall}px;
  margin-top: ${({ theme }) => theme.sizing.xxSmall}px;
`;

export default FormFieldWrapper;