import React, { useRef } from "react";
import {
  Platform,
  TextInput,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import {
  Controller,
  type Control,
  type FieldValues,
  type Path,
  type RegisterOptions,
} from "react-hook-form";
import styled from "styled-components/native";
import { ColorType } from "@nks/mobile-theme";

import { Typography } from "../typography";
import { Column, Row } from "../layout/Flex";

// ─── Types ───────────────────────────────────────────────────────────────
interface OtpInputProps<T extends FieldValues> {
  name: Path<T>;
  control: Control<T>;
  length?: number;
  label?: string;
  rules?: RegisterOptions<T, Path<T>>;
  autoFocus?: boolean;
}

// ─── Component ───────────────────────────────────────────────────────────
export function OtpInput<T extends FieldValues>({
  name,
  control,
  length = 6,
  label,
  rules,
  autoFocus = true,
}: OtpInputProps<T>): React.ReactElement | null {
  return (
    <Controller
      control={control}
      name={name}
      rules={rules}
      render={({ field: { value, onChange }, fieldState: { error } }) => (
        <Column gap="xSmall">
          {label && <Typography.Caption>{label}</Typography.Caption>}
          <OtpRow
            value={typeof value === "string" ? value : ""}
            onChange={onChange}
            length={length}
            hasError={!!error}
            autoFocus={autoFocus}
          />
          {error?.message && (
            <Typography.Caption colorType={ColorType.danger}>
              {error.message}
            </Typography.Caption>
          )}
        </Column>
      )}
    />
  );
}

export default OtpInput;

interface OtpRowProps {
  value: string;
  onChange: (value: string) => void;
  length: number;
  hasError: boolean;
  autoFocus: boolean;
}

function OtpRow({
  value,
  onChange,
  length,
  hasError,
  autoFocus,
}: OtpRowProps): React.ReactElement | null {
  const refs = useRef<Array<TextInput | null>>(Array(length).fill(null));

  if (refs.current.length !== length) {
    refs.current = Array(length).fill(null);
  }

  const digits: string[] = [];
  for (let i = 0; i < length; i++) {
    digits.push(value[i] ?? "");
  }

  const writeFrom = (start: number, chars: string): void => {
    const cleaned = chars.replace(/\D/g, "");
    if (cleaned.length === 0) {
      const next = digits.slice();
      next[start] = "";
      onChange(next.join(""));
      return;
    }

    const next = digits.slice();
    let writeIdx = start;
    for (let i = 0; i < cleaned.length && writeIdx < length; i++, writeIdx++) {
      next[writeIdx] = cleaned[i];
    }
    onChange(next.join(""));

    const focusIdx = Math.min(writeIdx, length - 1);
    refs.current[focusIdx]?.focus();
  };

  const handleKeyPress = (
    index: number,
    e: NativeSyntheticEvent<TextInputKeyPressEventData>,
  ): void => {
    if (e.nativeEvent.key === "Backspace" && !digits[index] && index > 0) {
      const next = digits.slice();
      next[index - 1] = "";
      onChange(next.join(""));
      refs.current[index - 1]?.focus();
    }
  };

  return (
    <Row gap="small" justify="center">
      {digits.map((digit, i) => (
        <OtpBoxField
          key={i}
          ref={(ref) => {
            refs.current[i] = ref;
          }}
          value={digit}
          onChangeText={(t) => writeFrom(i, t)}
          onKeyPress={(e) => handleKeyPress(i, e)}
          keyboardType="number-pad"
          maxLength={i === 0 ? length : 1}
          autoFocus={autoFocus && i === 0}
          textContentType={i === 0 ? "oneTimeCode" : "none"}
          autoComplete={
            Platform.OS === "android" && i === 0 ? "sms-otp" : "off"
          }
          selectTextOnFocus
          $filled={!!digit}
          $hasError={hasError}
        />
      ))}
    </Row>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────

const OtpBoxField = styled(TextInput)<{
  $filled: boolean;
  $hasError: boolean;
}>`
  width: ${({ theme }) => theme.sizing.xxLarge}px;
  height: ${({ theme }) => theme.sizing.xxLarge + theme.sizing.small}px;
  text-align: center;
  font-size: ${({ theme }) => theme.fontSize.xLarge}px;
  font-family: ${({ theme }) => theme.fontFamily.poppinsSemiBold};
  color: ${({ $filled, $hasError, theme }) =>
    $hasError
      ? theme.colorError
      : $filled
        ? theme.colorPrimary
        : theme.colorText};
  background-color: ${({ $filled, $hasError, theme }) =>
    $hasError
      ? theme.color.red.bg
      : $filled
        ? theme.color.primary.bg
        : theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xxLarge}px;
  border-width: ${({ $filled, $hasError, theme }) =>
    $filled || $hasError ? theme.borderWidth.light : theme.borderWidth.mild}px;
  border-color: ${({ $filled, $hasError, theme }) =>
    $hasError
      ? theme.colorError
      : $filled
        ? theme.colorPrimary
        : theme.colorBorder};
  shadow-color: ${({ $filled, theme }) => ($filled ? theme.colorPrimary : theme.colorText)};
  shadow-offset: 0px 2px;
  shadow-opacity: ${({ $filled }) => ($filled ? 0.18 : 0.04)};
  shadow-radius: 6px;
  elevation: ${({ $filled }) => ($filled ? 3 : 1)};
`;