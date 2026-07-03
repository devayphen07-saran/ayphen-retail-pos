import React, { useState } from "react";
import { StyleProp, TextInputProps, TouchableOpacity, ViewStyle } from "react-native";
import styled from "styled-components/native";
import {
  Controller,
  Control,
  ControllerRenderProps,
  ControllerFieldState,
  FieldValues,
  Path,
  PathValue,
  RegisterOptions,
} from "react-hook-form";
import { useMobileTheme, useBreakpoint } from "@ayphen/mobile-theme";
import { Eye, EyeOff } from "lucide-react-native";

import { FormFieldWrapper } from "../form/FormFieldWrapper";
import { StyledFormInput } from "../form/StyledFormInput";

interface PasswordInputProps<T extends FieldValues>
  extends Omit<TextInputProps, "defaultValue"> {
  name: Path<T>;
  control: Control<T>;
  label?: string;
  rules?: RegisterOptions<T, Path<T>>;
  disabled?: boolean;
  required?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
}

export function PasswordInput<T extends FieldValues>({
  name,
  control,
  label,
  rules,
  disabled = false,
  required = false,
  containerStyle,
  ...rest
}: PasswordInputProps<T>) {
  const [secure, setSecure] = useState(true);
  const { theme } = useMobileTheme();
  const { scale, fontScale } = useBreakpoint();
  const resolvedEditable = rest.editable ?? !disabled;
  const placeholderColor = theme.color.grey.borderActive;
  const toggleIconSize = Math.round(20 * scale);

  return (
    <Controller
      control={control}
      name={name}
      rules={rules}
      render={({
        field,
        fieldState,
      }: {
        field: ControllerRenderProps<T, Path<T>>;
        fieldState: ControllerFieldState;
      }) => {
        const displayValue = field.value == null ? "" : String(field.value);

        return (
          <FormFieldWrapper
            label={label}
            required={required}
            error={fieldState.error?.message}
            disabled={disabled}
            style={containerStyle}
          >
            <InputRow>
              <PasswordStyledInput
                value={displayValue}
                onChangeText={(text) =>
                  field.onChange(text as unknown as PathValue<T, Path<T>>)
                }
                onBlur={field.onBlur}
                secureTextEntry={secure}
                placeholderTextColor={placeholderColor}
                editable={resolvedEditable}
                hasError={!!fieldState.error}
                disabled={disabled}
                $scale={scale}
                $fontScale={fontScale}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={label}
                {...rest}
              />
              <ToggleButton
                onPress={() => setSecure((s) => !s)}
                disabled={disabled}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={secure ? "Show password" : "Hide password"}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                {secure ? (
                  <Eye
                    size={toggleIconSize}
                    color={theme.colorTextSecondary}
                  />
                ) : (
                  <EyeOff
                    size={toggleIconSize}
                    color={theme.colorTextSecondary}
                  />
                )}
              </ToggleButton>
            </InputRow>
          </FormFieldWrapper>
        );
      }}
    />
  );
}

const InputRow = styled.View`
  position: relative;
  flex-direction: row;
  align-items: center;
  width: 100%;
`;

const PasswordStyledInput = styled(StyledFormInput)`
  flex: 1;
  padding-right: ${({ theme }) => theme.padding.xxLarge}px;
`;

const ToggleButton = styled(TouchableOpacity)<{ disabled?: boolean }>`
  position: absolute;
  right: ${({ theme }) => theme.padding.medium}px;
  padding: ${({ theme }) => theme.padding.xxSmall}px;
  opacity: ${({ disabled }) => (disabled ? 0.5 : 1)};
`;
