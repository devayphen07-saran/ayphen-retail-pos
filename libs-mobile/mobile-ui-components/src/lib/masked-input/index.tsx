import React, { useCallback, useMemo } from "react";
import { StyleProp, TextInputProps, ViewStyle } from "react-native";
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
import { useMobileTheme, useBreakpoint } from "@nks/mobile-theme";

import { FormFieldWrapper } from "../form/FormFieldWrapper";
import { StyledFormInput } from "../form/StyledFormInput";
import {
  applyMask,
  unmask,
  MASK_PRESETS,
  MaskFormat,
  MaskPresetKey,
} from "./masks";

export { MASK_PRESETS, applyMask, unmask } from "./masks";
export type { MaskFormat, MaskPresetKey, MaskPreset } from "./masks";

type MaskOption =
  | { preset: MaskPresetKey; format?: never }
  | { preset?: never; format: MaskFormat };

interface MaskedInputBaseProps extends Omit<TextInputProps, "onChange" | "value" | "style"> {
  label?: string;
  required?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  /**
   * When true, the parent receives the raw value with separators stripped.
   * Defaults to true — most callers want to persist the canonical digits.
   */
  rawValue?: boolean;
}

interface UncontrolledMaskedInputProps extends MaskedInputBaseProps {
  value: string;
  onChange: (next: string) => void;
  error?: string;
  control?: undefined;
  name?: undefined;
}

interface ControlledMaskedInputProps<T extends FieldValues> extends MaskedInputBaseProps {
  control: Control<T>;
  name: Path<T>;
  rules?: RegisterOptions<T, Path<T>>;
  value?: undefined;
  onChange?: undefined;
  error?: undefined;
}

export type MaskedInputProps<T extends FieldValues> = MaskOption &
  (UncontrolledMaskedInputProps | ControlledMaskedInputProps<T>);

function resolveMask(preset: MaskPresetKey | undefined, format: MaskFormat | undefined) {
  if (preset) return MASK_PRESETS[preset];
  return { format: format as MaskFormat, keyboardType: undefined, maxLength: (format ?? "").length };
}

export function MaskedInput<T extends FieldValues>(
  props: MaskedInputProps<T>,
): React.ReactElement {
  const { theme } = useMobileTheme();
  const { scale, fontScale } = useBreakpoint();

  const mask = useMemo(
    () => resolveMask(props.preset, props.format),
    [props.preset, props.format],
  );

  const placeholderColor = theme.color.grey.borderActive;

  const transform = useCallback(
    (next: string): { display: string; raw: string } => {
      const cleanedRaw = unmask(mask.format, next);
      const display = applyMask(mask.format, cleanedRaw);
      return { display, raw: cleanedRaw };
    },
    [mask.format],
  );

  const renderField = (
    currentValue: string,
    onCommit: (display: string, raw: string) => void,
    error: string | undefined,
    onBlur?: () => void,
  ): React.ReactElement => {
    const display = applyMask(mask.format, unmask(mask.format, currentValue));
    return (
      <FormFieldWrapper
        label={props.label}
        required={props.required}
        error={error}
        disabled={props.disabled}
        style={props.containerStyle}
      >
        <MaskedStyledFormInput
          value={display}
          editable={!props.disabled}
          placeholder={mask.format.replace(/[9Aa*]/g, "•")}
          placeholderTextColor={placeholderColor}
          keyboardType={mask.keyboardType}
          maxLength={mask.maxLength}
          hasError={!!error}
          disabled={props.disabled}
          $scale={scale}
          $fontScale={fontScale}
          accessibilityLabel={props.label}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(text) => {
            const { display: next, raw } = transform(text);
            onCommit(next, raw);
          }}
          onBlur={onBlur}
        />
      </FormFieldWrapper>
    );
  };

  if (props.control && props.name) {
    return (
      <Controller
        control={props.control}
        name={props.name}
        rules={props.rules}
        render={({
          field,
          fieldState,
        }: {
          field: ControllerRenderProps<T, Path<T>>;
          fieldState: ControllerFieldState;
        }) => {
          const current = field.value == null ? "" : String(field.value);
          return renderField(
            current,
            (display, raw) => {
              const out = props.rawValue === false ? display : raw;
              field.onChange(out as unknown as PathValue<T, Path<T>>);
            },
            fieldState.error?.message,
            field.onBlur,
          );
        }}
      />
    );
  }

  const { value, onChange, error, rawValue } = props as UncontrolledMaskedInputProps;
  return renderField(
    value ?? "",
    (display, raw) => onChange(rawValue === false ? display : raw),
    error,
  );
}

export default MaskedInput;

const MaskedStyledFormInput = styled(StyledFormInput)`
  margin-bottom: ${({ theme }) => theme.sizing.small}px;
`;
