/**
 * RadioGroup.tsx
 *
 * A group of radio buttons. Two usage modes:
 *
 *   Uncontrolled:
 *     <RadioGroup options={opts} value={val} onChange={setVal} label="Type" />
 *
 *   Controlled (React Hook Form):
 *     <RadioGroup options={opts} name="productType" control={control} />
 *
 * Accessibility:
 *   - Container has accessibilityRole="radiogroup"
 *   - Each option has accessibilityRole="radio"
 *   - Each option has accessibilityState={{ checked, disabled }}
 *   - Each option announces its label to screen readers
 *   - Group label is announced by the radiogroup element
 *
 * Real-time scenarios:
 *   - Product type selector (Goods / Service / Bundle)
 *   - Payment method selector (Cash / UPI / Card)
 *   - Tax preference selector (Standard / Nil rated / Exempt / Non-GST)
 *   - Condition selector (New / Used / Refurbished)
 */

import React from 'react';
import styled from 'styled-components/native';
import {
  Controller,
  type Control,
  type FieldValues,
  type Path,
  type PathValue,
} from 'react-hook-form';
import { useBreakpoint } from '@ayphen/mobile-theme';
import { Typography } from '../typography';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RadioOption {
  label: string;
  value: string;
  /** Optional override for what screen readers announce. Defaults to label. */
  accessibilityLabel?: string;
}

export interface RadioGroupProps<T extends FieldValues = FieldValues> {
  options: RadioOption[];
  value?: string;
  onChange?: (val: string) => void;
  label?: string;
  name?: Path<T>;
  control?: Control<T>;
  errorMessage?: string;
  disabled?: boolean;
  testID?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RadioGroup<T extends FieldValues = FieldValues>({
  options,
  value,
  onChange,
  label,
  name,
  control,
  errorMessage,
  disabled = false,
  testID,
}: RadioGroupProps<T>) {
  const { scale, fontScale } = useBreakpoint();

  const renderGroup = (
    val:    string | undefined,
    change: (v: string) => void,
  ) => (
    <Container
      $disabled={disabled}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      testID={testID}
    >
      {label && (
        <GroupLabel $disabled={disabled}>
          {label}
        </GroupLabel>
      )}

      <OptionsWrapper>
        {options.map((opt) => {
          const selected = val === opt.value;

          return (
            <OptionTouchable
              key={opt.value}
              onPress={() => {
                if (!disabled) change(opt.value);
              }}
              disabled={disabled}
              // Full accessibility for each radio option
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled }}
              accessibilityLabel={opt.accessibilityLabel ?? opt.label}
              testID={testID ? `${testID}-option-${opt.value}` : undefined}
            >
              <OuterCircle
                selected={selected}
                $disabled={disabled}
                $scale={scale}
              >
                {selected && (
                  <InnerCircle $disabled={disabled} $scale={scale} />
                )}
              </OuterCircle>
              <OptionLabel $scale={scale} $fontScale={fontScale} $disabled={disabled}>
                {opt.label}
              </OptionLabel>
            </OptionTouchable>
          );
        })}
      </OptionsWrapper>

      {errorMessage && (
        <ErrorCaption>{errorMessage}</ErrorCaption>
      )}
    </Container>
  );

  // ── Controlled path ────────────────────────────────────────────────────────
  if (name && control) {
    return (
      <Controller
        name={name}
        control={control}
        render={({ field }) =>
          // Explicitly type the value to avoid shadowing the outer `value` prop
          // and to ensure PathValue<T, Path<T>> is safely converted to string
          renderGroup(
            field.value != null ? String(field.value) : undefined,
            (v) => field.onChange(v as PathValue<T, Path<T>>),
          )
        }
      />
    );
  }

  // ── Uncontrolled path ──────────────────────────────────────────────────────
  return renderGroup(value, onChange ?? (() => {}));
}

export default RadioGroup;

// ─── Styled components ────────────────────────────────────────────────────────

const Container = styled.View<{ $disabled?: boolean }>`
  margin-top:    ${({ theme }) => theme.sizing.xSmall}px;
  margin-bottom: ${({ theme }) => theme.sizing.xSmall}px;
  opacity: ${({ $disabled }) => ($disabled ? 0.6 : 1)};
`;

const GroupLabel = styled(Typography.Body)<{ $disabled?: boolean }>`
  color: ${({ $disabled, theme }) =>
    // Fixed: was using same colour for both states
    $disabled ? theme.colorTextSecondary : theme.colorText};
  margin-bottom: ${({ theme }) => theme.sizing.xxSmall}px;
`;

// Note: gap/column-gap replaced with margins on OptionTouchable for
// broader React Native version compatibility (gap unreliable in RN < 0.71)
const OptionsWrapper = styled.View`
  flex-direction: row;
  flex-wrap:      wrap;
  margin-top:     ${({ theme }) => theme.sizing.xxSmall}px;
`;

const OptionTouchable = styled.TouchableOpacity`
  flex-direction: row;
  align-items:    center;
  margin-bottom:  ${({ theme }) => theme.sizing.small}px;
  margin-right:   ${({ theme }) => theme.sizing.medium}px;
`;

const ErrorCaption = styled(Typography.Caption)`
  color:      ${({ theme }) => theme.colorError};
  margin-top: ${({ theme }) => theme.sizing.xxSmall}px;
`;
// Fixed: was using theme.color.red.main — colorError is the semantic token

const OuterCircle = styled.View<{
  selected:  boolean;
  $disabled?: boolean;
  $scale:    number;
}>`
  width:         ${({ $scale }) => Math.round(22 * $scale)}px;
  height:        ${({ $scale }) => Math.round(22 * $scale)}px;
  border-radius: ${({ $scale }) => Math.round(11 * $scale)}px;
  border-width:  ${({ theme }) => theme.borderWidth.light}px;

  border-color: ${({ $disabled, selected, theme }) =>
    // Simplified: disabled always gets colorBorder, selected gets colorPrimary,
    // unselected gets colorBorder. Previous version had a redundant conditional.
    !$disabled && selected ? theme.colorPrimary : theme.colorBorder};

  align-items:     center;
  justify-content: center;
`;

const InnerCircle = styled.View<{ $disabled?: boolean; $scale: number }>`
  width:            ${({ $scale }) => Math.round(12 * $scale)}px;
  height:           ${({ $scale }) => Math.round(12 * $scale)}px;
  border-radius:    ${({ $scale }) => Math.round(6 * $scale)}px;
  background-color: ${({ $disabled, theme }) =>
    $disabled ? theme.colorBorder : theme.colorPrimary};
`;

const OptionLabel = styled(Typography.Body)<{
  $scale:     number;
  $fontScale: number;
  $disabled:  boolean;
}>`
  margin-left: ${({ $scale, theme }) => Math.round(theme.sizing.xSmall * $scale)}px;
  color:       ${({ $disabled, theme }) =>
    $disabled ? theme.colorTextSecondary : theme.colorText};
  font-size:   ${({ $fontScale }) => 14 * $fontScale}px;
  line-height: ${({ $fontScale }) => 20 * $fontScale}px;
`;