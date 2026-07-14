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
import { useMobileTheme, useBreakpoint } from "@ayphen/mobile-theme";

import { FormFieldWrapper } from "../../form/FormFieldWrapper";
import { StyledFormFieldFrame } from "../../form/StyledFormInput";
import { Typography } from "../../typography";
import {
  formatMinorUnits,
  formatMinorUnitsNumeric,
  parseToMinorUnits,
  resolveFormat,
} from "./format";

export {
  formatMinorUnits,
  formatMinorUnitsNumeric,
  parseToMinorUnits,
  resolveFormat,
} from "./format";

interface AmountInputBaseProps
  extends Omit<TextInputProps, "value" | "onChange" | "style" | "keyboardType"> {
  /** ISO 4217 code (USD, INR, JPY, EUR, ...) */
  currency: string;
  /** BCP-47 locale used for grouping/decimals/symbol position. Defaults to en-US. */
  locale?: string;
  /** Override fractional digits (e.g. crypto: 8). Defaults to currency's natural minor units. */
  minorUnitsOverride?: number;
  /**
   * Show the currency symbol as a fixed prefix instead of inside the formatted
   * number. Makes the typing experience feel like a register entry pad.
   */
  symbolAsPrefix?: boolean;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  /** Renders a helper line below the field (e.g. "Tax included"). */
  helperText?: string;
}

interface UncontrolledAmountInputProps extends AmountInputBaseProps {
  /** Integer minor units. `null` = unset (placeholder shows). */
  value: number | null;
  onChange: (next: number | null) => void;
  error?: string;
  control?: undefined;
  name?: undefined;
}

interface ControlledAmountInputProps<T extends FieldValues> extends AmountInputBaseProps {
  control: Control<T>;
  name: Path<T>;
  rules?: RegisterOptions<T, Path<T>>;
  value?: undefined;
  onChange?: undefined;
  error?: undefined;
}

export type AmountInputProps<T extends FieldValues> =
  | UncontrolledAmountInputProps
  | ControlledAmountInputProps<T>;

export function AmountInput<T extends FieldValues>(
  props: AmountInputProps<T>,
): React.ReactElement {
  const { theme } = useMobileTheme();
  const { scale, fontScale } = useBreakpoint();

  const formatOpts = useMemo(
    () => ({
      currency: props.currency,
      locale: props.locale,
      minorUnitsOverride: props.minorUnitsOverride,
    }),
    [props.currency, props.locale, props.minorUnitsOverride],
  );

  const resolved = useMemo(() => resolveFormat(formatOpts), [formatOpts]);
  const placeholderColor = theme.color.grey.text;

  const formatForDisplay = useCallback(
    (minor: number | null): string => {
      if (props.symbolAsPrefix) {
        return formatMinorUnitsNumeric(minor, formatOpts);
      }
      return formatMinorUnits(minor, formatOpts);
    },
    [formatOpts, props.symbolAsPrefix],
  );

  const renderField = (
    minor: number | null,
    commit: (next: number | null) => void,
    error: string | undefined,
    onBlur?: () => void,
  ): React.ReactElement => {
    const display = formatForDisplay(minor);

    const handleChangeText = (text: string): void => {
      const next = parseToMinorUnits(text);
      commit(next);
    };

    return (
      <FormFieldWrapper
        label={props.label}
        required={props.required}
        error={error}
        disabled={props.disabled}
        style={props.containerStyle}
      >
        <StyledFormFieldFrame
          $hasError={!!error}
          $disabled={props.disabled}
          $scale={scale}
          $marginBottom={props.helperText ? theme.sizing.xxSmall : theme.sizing.small}
        >
          {props.symbolAsPrefix ? (
            <SymbolText accessibilityElementsHidden>{resolved.symbol}</SymbolText>
          ) : null}

          <AmountTextInput
            value={display}
            editable={!props.disabled}
            placeholder={formatForDisplay(0)}
            placeholderTextColor={placeholderColor}
            keyboardType="number-pad"
            $hasError={!!error}
            $fontScale={fontScale}
            accessibilityLabel={props.label ?? "Amount"}
            accessibilityRole="text"
            onChangeText={handleChangeText}
            onBlur={onBlur}
            selectTextOnFocus
            autoCorrect={false}
          />
        </StyledFormFieldFrame>

        {props.helperText ? (
          <HelperText>{props.helperText}</HelperText>
        ) : null}
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
          const raw = field.value;
          const minor =
            raw == null || raw === ""
              ? null
              : typeof raw === "number"
                ? raw
                : Number(raw);
          return renderField(
            Number.isFinite(minor as number) ? (minor as number | null) : null,
            (next) => field.onChange(next as unknown as PathValue<T, Path<T>>),
            fieldState.error?.message,
            field.onBlur,
          );
        }}
      />
    );
  }

  const { value, onChange, error } = props as UncontrolledAmountInputProps;
  return renderField(value, onChange, error);
}

const SymbolText = styled(Typography.Subtitle)`
  margin-right: ${({ theme }) => theme.sizing.xSmall}px;
  color: ${({ theme }) => theme.colorTextSecondary || theme.colorText};
`;

const HelperText = styled(Typography.Caption)`
  color: ${({ theme }) => theme.colorTextSecondary};
  margin-left: ${({ theme }) => theme.sizing.xxSmall}px;
  margin-bottom: ${({ theme }) => theme.sizing.small}px;
`;

const AmountTextInput = styled.TextInput<{
  $hasError?: boolean;
  $fontScale: number;
}>`
  flex: 1;
  text-align: right;
  font-family: ${({ theme }) => theme.fontFamily.poppinsMedium};
  font-size: ${({ theme, $fontScale }) => theme.fontSize.medium * $fontScale}px;
  color: ${({ theme, $hasError }) =>
    $hasError ? theme.colorError : theme.colorText};
`;

export default AmountInput;