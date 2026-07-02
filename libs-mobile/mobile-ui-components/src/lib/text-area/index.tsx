/**
 * TextArea.tsx
 *
 * Multi-line text input. Two usage modes:
 *
 *   Uncontrolled:
 *     <TextArea value={text} onChange={setText} label="Notes" />
 *
 *   Controlled (React Hook Form):
 *     <TextArea name="description" control={control} label="Description" />
 *
 * Key fixes over previous version:
 *
 * 1. Custom placeholder removed — uses TextInput's native placeholder prop.
 *    The custom overlay hid the placeholder immediately on focus (before any
 *    typing), which is incorrect UX. Native placeholder hides only when text
 *    is typed, which is the expected behaviour.
 *
 * 2. Focused border colour applied — isFocused state now changes the border
 *    colour via inline style override. Previously the state was tracked but
 *    never used visually.
 *
 * 3. field.onBlur() called in controlled path so RHF's validation-on-blur
 *    fires correctly.
 *
 * 4. Number() replaced with parseFloat() for safe theme value extraction —
 *    prevents NaNpx in border-radius and padding.
 *
 * 5. height prop renamed to minHeight — the textarea grows beyond the min,
 *    which is the correct behaviour for a multiline input.
 *
 * 6. accessibilityState and accessibilityHint added.
 *
 * 7. Dev warning when uncontrolled TextArea has no onChange — silent
 *    discard of input is a confusing failure mode.
 */

import React, { useCallback, useState } from 'react';
import {
  StyleProp,
  TextInputProps,
  ViewStyle,
} from 'react-native';
import styled from 'styled-components/native';
import {
  Controller,
  type Control,
  type ControllerFieldState,
  type ControllerRenderProps,
  type FieldValues,
  type Path,
  type PathValue,
  type RegisterOptions,
} from 'react-hook-form';
import { useMobileTheme, useBreakpoint } from '@nks/mobile-theme';

import { FormFieldWrapper } from '../form/FormFieldWrapper';
import { inputStyles } from '../input/style';

// ─── Safe numeric extractor (same as StyledFormInput) ────────────────────────

function num(value: unknown): number {
  const parsed = parseFloat(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface TextAreaProps<T extends FieldValues>
  extends Omit<TextInputProps, 'onChange' | 'value' | 'style'> {
  // ── Uncontrolled ────────────────────────────────────────────────────────────
  value?: string;
  onChange?: (value: string) => void;
  /** Passed directly to FormFieldWrapper — shown below the field on error. */
  error?: string;

  // ── React Hook Form ─────────────────────────────────────────────────────────
  name?: Path<T>;
  control?: Control<T>;
  rules?: RegisterOptions<T, Path<T>>;

  // ── Appearance ──────────────────────────────────────────────────────────────
  style?: StyleProp<ViewStyle>;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;

  /**
   * Minimum height of the textarea in logical pixels before scale is applied.
   * The textarea can grow beyond this value as content increases.
   * Renamed from `height` — the previous name implied a fixed height.
   * Defaults to 100.
   */
  minHeight?: number;

  // ── Accessibility ────────────────────────────────────────────────────────────
  accessibilityHint?: string;

  // ── Testing ──────────────────────────────────────────────────────────────────
  testID?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TextArea<T extends FieldValues>({
  value,
  onChange,
  name,
  control,
  rules,
  style,
  label,
  required,
  disabled  = false,
  placeholder,
  minHeight = 100,
  error,
  accessibilityHint,
  testID,
  ...rest
}: TextAreaProps<T>) {
  const { theme }              = useMobileTheme();
  const { scale, fontScale }   = useBreakpoint();
  const [isFocused, setIsFocused] = useState(false);

  // Warn in dev when uncontrolled TextArea has no onChange — all input will
  // be silently discarded without this prop
  if (__DEV__ && !name && !control && onChange === undefined) {
    console.warn(
      '[TextArea] No onChange prop provided and no control/name for RHF. ' +
        'User input will be discarded silently.',
    );
  }

  // ── Render function shared by controlled and uncontrolled paths ───────────
  const renderArea = useCallback(
    (
      val: string,
      setVal: (v: string) => void,
      onBlurCallback: (() => void) | undefined,
      errorMsg: string | undefined,
    ): React.ReactElement => (
      <FormFieldWrapper
        label={label}
        required={required}
        error={errorMsg}
        disabled={disabled}
        style={[{ marginBottom: theme.sizing.small }, style]}
      >
        <StyledTextArea
          value={val}
          onChangeText={setVal}
          editable={!disabled}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
          placeholder={placeholder}
          placeholderTextColor={theme.colorTextTertiary}
          hasError={!!errorMsg}
          $minHeight={minHeight}
          $scale={scale}
          $fontScale={fontScale}
          $isFocused={isFocused}
          accessibilityLabel={label}
          accessibilityHint={accessibilityHint}
          accessibilityState={{
            disabled,
            // invalid is announced to screen readers when there is an error
            ...(errorMsg ? { invalid: true } : {}),
          } as object}
          testID={testID}
          onFocus={() => setIsFocused(true)}
          onBlur={() => {
            setIsFocused(false);
            onBlurCallback?.();
          }}
          {...rest}
        />
      </FormFieldWrapper>
    ),
    // Deps: all values used inside renderArea that can change
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      label, required, disabled, style, placeholder, minHeight,
      scale, fontScale, isFocused, accessibilityHint, testID, theme,
    ],
  );

  // ── Controlled path ────────────────────────────────────────────────────────
  if (name && control) {
    return (
      <Controller
        name={name}
        control={control}
        rules={rules}
        render={({
          field,
          fieldState,
        }: {
          field:      ControllerRenderProps<T, Path<T>>;
          fieldState: ControllerFieldState;
        }) =>
          renderArea(
            (field.value as string | undefined) ?? '',
            (v) => field.onChange(v as PathValue<T, Path<T>>),
            field.onBlur,        // ← previously missing: triggers RHF validation on blur
            fieldState.error?.message,
          )
        }
      />
    );
  }

  // ── Uncontrolled path ──────────────────────────────────────────────────────
  return renderArea(
    value ?? '',
    onChange ?? (() => {}),
    undefined,
    error,
  );
}

export default TextArea;

// ─── Styled components ────────────────────────────────────────────────────────

interface StyledTextAreaProps {
  $minHeight: number;
  hasError?:  boolean;
  $scale:     number;
  $fontScale: number;
  $isFocused: boolean;
}

const StyledTextArea = styled.TextInput<StyledTextAreaProps>`
  ${({ theme, hasError, $scale, $fontScale }) => {
    const s = inputStyles(theme, hasError);
    return `
      border-width:  ${num(s.borderWidth)}px;
      border-radius: ${num(s.borderRadius) * $scale}px;
      padding:       ${num(s.padding) * $scale}px;
      font-size:     ${num(s.fontSize) * $fontScale}px;
      font-family:   ${String(s.fontFamily)};
      color:         ${String(s.color)};
    `;
  }}

  border-color: ${({ hasError, $isFocused, theme }) =>
    hasError
      ? theme.colorError
      : $isFocused
        ? theme.colorPrimary
        : theme.colorBorder};

  min-height:       ${({ $minHeight, $scale }) => $minHeight * $scale}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  width:            100%;
`;
// Note: border-color is a separate declaration (not inside the interpolation
// function) so it can reference $isFocused reactively. The interpolation
// function runs once at style creation, not on every re-render.
// The $isFocused value IS reactive because styled-components re-renders
// when props change — this is the correct pattern.