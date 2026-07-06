/**
 * Input.tsx
 *
 * Reusable controlled form input for React Hook Form.
 *
 * Design decisions:
 * - sanitizeValue and getTypeProps are module-level pure functions — no
 *   recreation on render, no closure over component state.
 * - handleChangeText is built inside the Controller render prop but kept
 *   minimal: sanitise → early-exit if unchanged → optionally parse → commit.
 * - disabled always wins over editable. If disabled=true the field is
 *   never editable regardless of the editable prop.
 * - Prefix/suffix frame tracks focused state so the focus ring renders
 *   correctly even when the TextInput is inside a wrapper View.
 * - email type strips leading/trailing whitespace on blur because iOS
 *   autocorrect silently inserts spaces around the @ symbol.
 * - number type cleans up a trailing "." on blur (user typed "12." and
 *   tabbed away — should become "12").
 * - The ref cast uses a callback form to satisfy both RHF's RefCallback
 *   and RN's TextInput ref contract without unsafe assertions.
 *
 * Real-time scenarios covered:
 * - POS cashier scans barcode into a field   → sku type strips spaces, uppercases
 * - Owner enters a price                     → number type blocks double decimals
 * - Cashier types a quantity                 → integer type strips decimals
 * - Owner enters phone number                → phoneNumber type allows +, -, ( )
 * - Owner pastes an email with spaces        → email type strips whitespace on blur
 * - Tablet layout                            → $scale applied to frame AND inner text
 * - Screen reader                            → full a11y label / hint / state chain
 * - Form submitting                          → disabled=true makes field non-editable
 *   and announces disabled state to screen readers
 * - Field inside a form with returnKeyType   → passes through via ...rest
 * - autoFocus on search inputs               → passes through via ...rest
 */

import React, { useRef, useState } from 'react';
import {
  StyleProp,
  TextInput,
  TextInputProps,
  ViewStyle,
} from 'react-native';
import styled from 'styled-components/native';

import {
  Control,
  Controller,
  ControllerFieldState,
  ControllerRenderProps,
  FieldValues,
  Path,
  PathValue,
  RegisterOptions,
} from 'react-hook-form';
import { useMobileTheme, useBreakpoint } from '@ayphen/mobile-theme';

import { FormFieldWrapper } from '../form/FormFieldWrapper';
import { StyledFormInput, StyledFormFieldFrame } from '../form/StyledFormInput';

// ─── Types ────────────────────────────────────────────────────────────────────

export type InputDataType =
  | 'email'
  | 'phoneNumber'
  | 'text'
  | 'number'
  | 'integer'
  | 'sku';

export interface InputProps<T extends FieldValues> extends TextInputProps {
  // ── Required ──────────────────────────────────────────────────────────────
  name: Path<T>;
  control: Control<T>;

  // ── Label / wrapper ───────────────────────────────────────────────────────
  label?: string;
  required?: boolean;
  containerStyle?: StyleProp<ViewStyle>;

  // ── Behaviour ─────────────────────────────────────────────────────────────
  /**
   * Controls which keyboard, sanitisation rules, and autocomplete hints are
   * applied. Defaults to 'text'.
   *
   * 'email'       — email keyboard, no caps, strips whitespace on blur
   * 'phoneNumber' — phone pad, allows +, -, (, ), space
   * 'text'        — default keyboard, autocorrect on
   * 'number'      — decimal pad, blocks multiple decimal points
   * 'integer'     — number pad, digits only
   * 'sku'         — default keyboard, strips spaces, uppercases
   */
  inputDataType?: InputDataType;

  /**
   * When true, the field is non-editable and announces "disabled" to screen
   * readers. Always wins over the `editable` prop — if disabled=true the field
   * cannot be edited regardless of what editable is set to.
   */
  disabled?: boolean;

  /**
   * For 'number' and 'integer' types: write a JS number (or null for empty)
   * to the form state instead of a string. Pair with .nullable() in your
   * Zod/Yup schema. Defaults to false for backward compatibility.
   */
  parseAsNumber?: boolean;

  // ── Prefix / suffix ───────────────────────────────────────────────────────
  /**
   * Content rendered to the left of the text input inside the field frame.
   * Common use: currency symbol (₹), search icon.
   */
  prefix?: React.ReactNode;

  /**
   * Content rendered to the right of the text input inside the field frame.
   * Common use: scan icon (barcode), clear button, unit label.
   */
  suffix?: React.ReactNode;

  // ── Validation ────────────────────────────────────────────────────────────
  /**
   * React Hook Form validation rules. Async validators are supported via the
   * validate key: `validate: async (v) => await checkUnique(v) || 'Already taken'`
   */
  rules?: RegisterOptions<T, Path<T>>;

  // ── Accessibility ─────────────────────────────────────────────────────────
  /**
   * Override the accessibility label announced by screen readers.
   * Defaults to: label → placeholder → field name.
   */
  accessibilityLabel?: string;

  /**
   * Additional hint read after the accessibility label.
   * Example: "Double-tap to edit" or "Tap to scan barcode"
   */
  accessibilityHint?: string;

  // ── Testing ───────────────────────────────────────────────────────────────
  /**
   * testID for E2E tests. Defaults to `input-{name}`.
   */
  testID?: string;
}

// ─── Per-type TextInput configuration ────────────────────────────────────────
//
// autoCapitalize: 'characters' on Android is only honoured when keyboardType
// is 'default'. For sku we use 'default' so autoCapitalize fires, but the
// sanitizer also uppercases — providing two layers of defence.
//
// textContentType hints are iOS-only and tell iOS Keychain / AutoFill what
// kind of value this field holds.

const TYPE_PROPS: Record<InputDataType, Partial<TextInputProps>> = {
  email: {
    keyboardType: 'email-address',
    autoCapitalize: 'none',
    autoCorrect: false,
    autoComplete: 'email',
    textContentType: 'emailAddress',
  },
  phoneNumber: {
    keyboardType: 'phone-pad',
    autoCapitalize: 'none',
    autoCorrect: false,
    autoComplete: 'tel',
    textContentType: 'telephoneNumber',
  },
  text: {
    keyboardType: 'default',
    autoCapitalize: 'sentences',
    autoCorrect: true,
  },
  number: {
    keyboardType: 'decimal-pad',
    autoCapitalize: 'none',
    autoCorrect: false,
    autoComplete: 'off',
  },
  integer: {
    keyboardType: 'number-pad',
    autoCapitalize: 'none',
    autoCorrect: false,
    autoComplete: 'off',
  },
  sku: {
    // 'default' keyboard so autoCapitalize: 'characters' is respected on Android.
    // The sanitizer also uppercases, so both layers are in effect.
    keyboardType: 'default',
    autoCapitalize: 'characters',
    autoCorrect: false,
    autoComplete: 'off',
  },
};

// ─── Module-level pure helpers ────────────────────────────────────────────────
//
// Defined outside the component so they are never recreated on render.
// Both accept inputDataType as a parameter — they have no dependency on
// component instance state or props beyond what they receive.

/**
 * Sanitise raw text input per type. Returns the cleaned string only.
 * Numeric parsing (if requested) happens separately in handleChangeText.
 */
function sanitizeValue(text: string, type: InputDataType): string {
  switch (type) {
    case 'integer':
      // Digits only — no decimal, no minus, no sign
      return text.replace(/[^0-9]/g, '');

    case 'number': {
      // Strip non-numerics, then allow only the first decimal point.
      // "1.2.3" → "1.2", "abc1.5" → "1.5", ".5" → ".5" (valid prefix)
      const cleaned = text.replace(/[^0-9.]/g, '');
      const firstDot = cleaned.indexOf('.');
      if (firstDot === -1) return cleaned;
      return (
        cleaned.slice(0, firstDot + 1) +
        cleaned.slice(firstDot + 1).replace(/\./g, '')
      );
    }

    case 'phoneNumber':
      // Allow digits, +, -, (, ), and spaces for international formats.
      // E.g. "+91 98765 43210", "(022) 2654-3210"
      return text.replace(/[^\d+\-()\s]/g, '');

    case 'sku':
      // Barcodes and SKUs: strip all whitespace, uppercase everything.
      // A scanner firing twice produces "EAN1EAN1" — maxLength handles that.
      return text.replace(/\s/g, '').toUpperCase();

    case 'email':
      // Do not strip mid-input — user is still typing. Strip happens on blur.
      // Stripping here would prevent typing "user@" before the domain.
      return text;

    case 'text':
    default:
      return text;
  }
}

/**
 * Post-blur cleanup per type.
 * Called in onBlur BEFORE React Hook Form's own onBlur so the stored value
 * is clean by the time validation runs.
 */
function sanitizeOnBlur(text: string, type: InputDataType): string {
  switch (type) {
    case 'email':
      // iOS autocorrect inserts spaces around @ in pasted addresses.
      // Trim and also strip internal spaces that have no place in an email.
      return text.trim().replace(/\s/g, '');

    case 'number':
      // "12." is technically invalid — remove the trailing dot on blur.
      return text.endsWith('.') ? text.slice(0, -1) : text;

    case 'text':
      // Trim leading/trailing whitespace from free-text fields on blur.
      return text.trim();

    default:
      return text;
  }
}

/**
 * Convert a raw form value to its display string.
 * Handles null, undefined, NaN, numbers, and strings safely without any
 * unsafe type casts.
 */
function toDisplayString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return Number.isNaN(value) ? '' : String(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  // Object, array, or anything else — log in dev and show empty
  if (__DEV__) {
    console.warn(
      '[Input] Unexpected non-primitive form value:',
      typeof value,
      value,
    );
  }
  return '';
}

// ─── Spacing constants ────────────────────────────────────────────────────────
//
// These match the Figma spacing scale:
//   FIELD_BOTTOM_GAP = spacing/3 (13px) — gap below each field in a form column
//   PREFIX_SUFFIX_GAP = spacing/2 (8px) — gap between prefix/input/suffix
//
// TODO: replace with theme.spacing.fieldGap and theme.spacing.inputInner
// when the theme tokens are published (Figma component v2.1).
const FIELD_BOTTOM_GAP = 13;
const PREFIX_SUFFIX_GAP = 8;

// ─── Component ────────────────────────────────────────────────────────────────

function InputInner<T extends FieldValues>({
  name,
  control,
  label,
  rules,
  inputDataType = 'text',
  disabled = false,
  required = false,
  prefix,
  suffix,
  editable,
  containerStyle,
  parseAsNumber = false,
  accessibilityLabel: a11yLabelOverride,
  accessibilityHint: a11yHintOverride,
  placeholder,
  testID,
  ...rest
}: InputProps<T>) {
  const { theme } = useMobileTheme();
  const { scale, fontScale } = useBreakpoint();

  // disabled always wins — an explicitly disabled field cannot be made
  // editable by also passing editable={true}.
  const resolvedEditable = disabled ? false : (editable ?? true);

  const typeProps = TYPE_PROPS[inputDataType];
  const a11yLabel = a11yLabelOverride ?? label ?? placeholder ?? String(name);
  const resolvedTestID = testID ?? `input-${String(name)}`;

  // Focused state for the prefix/suffix frame — the inner TextInput triggers
  // focus/blur but the visible ring needs to be on the outer frame.
  const [isFocused, setIsFocused] = useState(false);

  // Stable ref for the underlying TextInput — exposed via field.ref so
  // React Hook Form can focus the field programmatically.
  const inputRef = useRef<TextInput>(null);

  return (
    <Controller
      name={name}
      control={control}
      rules={rules}
      render={({
        field,
        fieldState,
      }: {
        field: ControllerRenderProps<T, Path<T>>;
        fieldState: ControllerFieldState;
      }) => {
        // ── Value → display string ────────────────────────────────────────
        const displayValue = toDisplayString(field.value);

        // ── Change handler ────────────────────────────────────────────────
        // Defined inline (not useCallback) because field.onChange changes
        // identity on every RHF render — useCallback deps would always fire.
        const handleChangeText = (text: string): void => {
          const sanitized = sanitizeValue(text, inputDataType);

          // Skip re-render if sanitisation produced no change.
          // This covers the case where a user types an invalid character
          // that gets stripped — the form state should not re-fire.
          if (sanitized === displayValue) return;

          let nextValue: unknown = sanitized;

          if (
            parseAsNumber &&
            (inputDataType === 'number' || inputDataType === 'integer')
          ) {
            if (sanitized === '' || sanitized === '.') {
              // Empty or lone decimal → null (not NaN) so .nullable()
              // schemas receive a clean "no value" signal.
              nextValue = null;
            } else {
              const parsed =
                inputDataType === 'integer'
                  ? parseInt(sanitized, 10)
                  : parseFloat(sanitized);
              // parseInt on a digit-only string (already sanitized) cannot
              // return NaN, but we guard anyway for forward safety.
              nextValue = Number.isNaN(parsed) ? null : parsed;
            }
          }

          field.onChange(nextValue as PathValue<T, Path<T>>);
        };

        // ── Blur handler ──────────────────────────────────────────────────
        // 1. Run post-blur sanitisation (email trim, trailing dot strip)
        // 2. Update form state if sanitisation changed the value
        // 3. Fire RHF's own onBlur to trigger validation
        // 4. Clear focused state for the prefix/suffix frame ring
        const handleBlur = (): void => {
          const cleaned = sanitizeOnBlur(displayValue, inputDataType);
          if (cleaned !== displayValue) {
            field.onChange(cleaned as PathValue<T, Path<T>>);
          }
          field.onBlur();
          setIsFocused(false);
        };

        // ── Focus handler ─────────────────────────────────────────────────
        const handleFocus = (e: Parameters<NonNullable<TextInputProps['onFocus']>>[0]): void => {
          setIsFocused(true);
          rest.onFocus?.(e);
        };

        // ── Ref callback ──────────────────────────────────────────────────
        // React Hook Form provides a RefCallback (not a React.RefObject).
        // We satisfy both RHF and RN's TextInput ref contract by combining
        // the callback ref with our own stable ref object.
        const refCallback = (instance: TextInput | null): void => {
          (inputRef as React.MutableRefObject<TextInput | null>).current =
            instance;
          if (typeof field.ref === 'function') {
            field.ref(instance);
          }
        };

        // ── Props shared by both rendering paths ──────────────────────────
        const commonProps: TextInputProps & { ref: typeof refCallback } = {
          ref: refCallback,
          value: displayValue,
          editable: resolvedEditable,
          placeholder,
          placeholderTextColor: theme.colorTextTertiary,
          accessibilityLabel: a11yLabel,
          accessibilityHint: a11yHintOverride,
          accessibilityState: {
            disabled: !resolvedEditable,
            // busy could be wired here if a submitting prop is added in future
          },
          testID: resolvedTestID,
          ...typeProps,
          ...rest,
          // These must come AFTER ...rest so our handlers are not overridden
          onChangeText: handleChangeText,
          onBlur: handleBlur,
          onFocus: handleFocus,
        };

        const hasPrefixOrSuffix = prefix != null || suffix != null;

        return (
          <FormFieldWrapper
            label={label}
            required={required}
            error={fieldState.error?.message}
            disabled={disabled}
            style={containerStyle}
          >
            {hasPrefixOrSuffix ? (
              <StyledFormFieldFrame
                $hasError={!!fieldState.error}
                $scale={scale}
                style={{
                  columnGap: PREFIX_SUFFIX_GAP,
                  marginBottom: FIELD_BOTTOM_GAP,
                  // StyledFormFieldFrame has no $focused prop — apply the
                  // focus ring via inline style so we don't have to modify
                  // the shared component. Error border takes priority over
                  // focus ring, which takes priority over default border.
                  borderColor: fieldState.error
                    ? theme.colorError
                    : isFocused
                      ? theme.colorPrimary
                      : theme.colorBorder,
                }}
              >
                {prefix}
                <FrameInput
                  {...commonProps}
                  $fontScale={fontScale}
                  $scale={scale}
                />
                {suffix}
              </StyledFormFieldFrame>
            ) : (
              <StyledFormInput
                {...commonProps}
                $hasError={!!fieldState.error}
                $scale={scale}
                $fontScale={fontScale}
                style={{ marginBottom: FIELD_BOTTOM_GAP }}
              />
            )}
          </FormFieldWrapper>
        );
      }}
    />
  );
}

// React.memo with a generic component requires a cast.
// The forwardRef + generic pattern is avoided here because RHF manages the ref
// internally via the Controller — consumers should not need to forward refs.
export const Input = React.memo(InputInner) as typeof InputInner;

export default Input;

// ─── Styled components ────────────────────────────────────────────────────────

/**
 * The transparent input inside a prefix/suffix frame.
 *
 * Receives both $scale and $fontScale so its font size and line height stay
 * consistent with the outer frame's padding on tablet breakpoints.
 * The original only received $fontScale, which caused text misalignment on
 * tablets because the frame padding scaled but the text line height did not.
 */
const FrameInput = styled.TextInput.attrs({
  textAlignVertical: 'center',
  style: { includeFontPadding: false },
})<{ $fontScale: number; $scale: number }>`
  flex: 1;
  padding: 0px;
  font-family: ${({ theme }) => theme.fontFamily.poppinsRegular};
  font-size: ${({ theme, $fontScale }) => theme.fontSize.small * $fontScale}px;
  line-height: ${({ theme, $fontScale, $scale }) =>
    theme.fontSize.small * $fontScale * 1.4 * $scale}px;
  color: ${({ theme }) => theme.colorText};
`;
