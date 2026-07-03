/**
 * CheckBox.tsx
 *
 * Controlled and uncontrolled checkbox. Two usage modes:
 *
 *   Uncontrolled (standalone):
 *     <CheckBox value={checked} onValueChange={setChecked} label="Accept terms" />
 *
 *   Controlled (React Hook Form):
 *     <CheckBox name="acceptTerms" control={control} label="Accept terms" />
 *
 * The visual checkmark uses the Lucide Check icon instead of a Unicode ✓
 * character. Unicode checkmarks render at inconsistent positions and sizes
 * across Android devices and font families — Lucide icons are vector and
 * always pixel-perfect.
 *
 * Accessibility:
 *   - accessibilityRole="checkbox" on the Pressable
 *   - accessibilityState={{ checked, disabled }} on the Pressable
 *   - accessibilityLabel defaults to the label prop
 *   - accessibilityHint prop forwarded to Pressable
 *
 * Real-time scenarios:
 *   - Terms acceptance on register screen
 *   - Filter toggles in a product list
 *   - Bulk-select rows in an order list
 *   - Settings toggles (track inventory, is_we_sell_this_item)
 */

import React from 'react';
import {
  Pressable,
  type PressableProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import styled from 'styled-components/native';
import {
  Controller,
  type Control,
  type FieldValues,
  type Path,
  type PathValue,
  type RegisterOptions,
} from 'react-hook-form';
import { useMobileTheme, useBreakpoint } from '@ayphen/mobile-theme';
import { LucideIcon } from '../lucide-icon';

// ─── Types ────────────────────────────────────────────────────────────────────

type CheckBoxVisualProps = {
  value: boolean;
  onValueChange?: (nextValue: boolean) => void;
  disabled?: boolean;
  size?: number;
  /** Checked background colour. Defaults to theme.colorPrimary. */
  color?: string;
  /** Unchecked background colour. Defaults to transparent. */
  uncheckedColor?: string;
  /** Border colour. Defaults to theme.colorBorder. */
  borderColor?: string;
  borderWidth?: number;
  /**
   * Corner radius of the checkbox box. Scaled automatically with the
   * breakpoint scale — pass the logical radius, not the scaled value.
   * Defaults to 5.
   */
  radius?: number;
  label?: string;
  /** Position of the label relative to the checkbox. Defaults to 'right'. */
  labelPosition?: 'left' | 'right' | 'top' | 'bottom';
  labelStyle?: TextStyle;
  containerStyle?: ViewStyle;
  checkboxStyle?: ViewStyle;
  /** Hint text announced to screen readers after the label. */
  accessibilityHint?: string;
  testID?: string;
};

type CheckBoxBaseProps = Omit<PressableProps, 'onPress'> & CheckBoxVisualProps;

export type ControlledCheckBoxProps<TFieldValues extends FieldValues> = Omit<
  PressableProps,
  'onPress'
> &
  Omit<CheckBoxVisualProps, 'value' | 'onValueChange'> & {
    name: Path<TFieldValues>;
    control: Control<TFieldValues>;
    rules?: Omit<
      RegisterOptions<TFieldValues, Path<TFieldValues>>,
      'valueAsNumber' | 'valueAsDate' | 'setValueAs'
    >;
    defaultValue?: boolean;
  };

export type CheckBoxProps<TFieldValues extends FieldValues = FieldValues> =
  | CheckBoxBaseProps
  | ControlledCheckBoxProps<TFieldValues>;

// ─── BoxStyleProps ────────────────────────────────────────────────────────────

type BoxStyleProps = {
  $size:           number;
  $checked:        boolean;
  $color:          string;
  $uncheckedColor: string;
  $borderColor:    string;
  $borderWidth:    number;
  $radius:         number;
  $disabled:       boolean;
};

// ─── CheckBoxBase ─────────────────────────────────────────────────────────────

function CheckBoxBase({
  value,
  onValueChange,
  disabled = false,
  size: sizeProp,
  color,
  uncheckedColor = 'transparent',
  borderColor,
  borderWidth = 2,
  radius = 5,
  label,
  labelPosition = 'right',
  labelStyle,
  containerStyle,
  checkboxStyle,
  accessibilityLabel,
  accessibilityHint,
  testID,
  ...pressableProps
}: CheckBoxBaseProps) {
  const { theme } = useMobileTheme();
  const { scale, fontScale } = useBreakpoint();
  const size = sizeProp ?? Math.round(20 * scale);

  // Validate color prop in dev — empty string is a consumer error
  if (__DEV__ && color !== undefined && color === '') {
    console.warn('[CheckBox] color prop is an empty string. Pass undefined to use the theme default.');
  }

  const resolvedColor  = color || theme.colorPrimary;
  const resolvedBorder = borderColor ?? theme.color?.primary?.border ?? theme.colorBorder;

  // Scale the corner radius so it grows proportionally on tablets
  const scaledRadius = Math.round(radius * scale);

  // The icon size inside the box — slightly smaller than the box to leave
  // a visual margin between the checkmark and the border
  const iconSize = Math.round(size * 0.65);

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      disabled={disabled}
      onPress={() => {
        if (!disabled) onValueChange?.(!value);
      }}
      testID={testID}
      {...pressableProps}
    >
      <Root $labelPosition={labelPosition} $scale={scale} style={containerStyle}>
        <Box
          $size={size}
          $checked={value}
          $color={resolvedColor}
          $uncheckedColor={uncheckedColor}
          $borderColor={resolvedBorder}
          $borderWidth={borderWidth}
          $radius={scaledRadius}
          $disabled={disabled}
          style={checkboxStyle}
          // testID on the visual element for E2E assertions on the checkbox appearance
          testID={testID ? `${testID}-box` : undefined}
        >
          {value && (
            // Lucide Check icon instead of Unicode ✓ — always pixel-perfect
            // on every Android font and screen density
            <LucideIcon
              name="Check"
              size={iconSize}
              color={disabled ? theme.colorTextSecondary : theme.colorWhite}
            />
          )}
        </Box>

        {label && (
          <Label
            $labelPosition={labelPosition}
            $fontScale={fontScale}
            $disabled={disabled}
            style={labelStyle}
          >
            {label}
          </Label>
        )}
      </Root>
    </Pressable>
  );
}

// ─── CheckBox ─────────────────────────────────────────────────────────────────

export function CheckBox<TFieldValues extends FieldValues>(
  props: CheckBoxProps<TFieldValues>,
) {
  if ('control' in props) {
    const { name, control, rules, defaultValue = false, ...rest } = props;
    return (
      <Controller
        name={name}
        control={control}
        rules={rules}
        // Typed correctly — no `as any` cast needed
        defaultValue={defaultValue as PathValue<TFieldValues, Path<TFieldValues>>}
        render={({ field: { value, onChange } }) => (
          <CheckBoxBase
            {...(rest as Omit<CheckBoxBaseProps, 'value' | 'onValueChange'>)}
            value={Boolean(value)}
            onValueChange={(next) => onChange(next)}
          />
        )}
      />
    );
  }

  return <CheckBoxBase {...props} />;
}

// ControlledCheckBox kept for backward compatibility with existing consumers.
// New code should use <CheckBox name={...} control={...} /> directly.
export function ControlledCheckBox<TFieldValues extends FieldValues>(
  props: ControlledCheckBoxProps<TFieldValues>,
) {
  return <CheckBox {...props} />;
}

// ─── Styled components ────────────────────────────────────────────────────────

const Root = styled.View<{
  $labelPosition: 'left' | 'right' | 'top' | 'bottom';
  $scale: number;
}>`
  flex-direction: ${({ $labelPosition }) =>
    $labelPosition === 'right'
      ? 'row'
      : $labelPosition === 'left'
        ? 'row-reverse'
        : $labelPosition === 'bottom'
          ? 'column'
          : 'column-reverse'};
  justify-content: flex-start;
  align-items: center;
  padding-top: ${({ theme, $scale }) => theme.sizing.xxSmall * $scale}px;
  padding-bottom: ${({ theme, $scale }) => theme.sizing.xxSmall * $scale}px;
`;

const Box = styled.View<BoxStyleProps>`
  width:         ${({ $size }) => $size}px;
  height:        ${({ $size }) => $size}px;
  border-radius: ${({ $radius }) => $radius}px;
  border-width:  ${({ $borderWidth }) => $borderWidth}px;

  border-color: ${({ $disabled, theme, $borderColor }) =>
    $disabled ? theme.colorBorder : $borderColor};

  align-items:     center;
  justify-content: center;

  background-color: ${({ $disabled, theme, $checked, $color, $uncheckedColor }) => {
    if ($disabled && $checked) return theme.colorBorder;   // disabled + checked: muted fill
    if ($disabled)              return theme.colorBgLayout; // disabled unchecked: subtle bg
    return $checked ? $color : $uncheckedColor;
  }};
`;
// Note: NO opacity applied to Box. Colour changes alone communicate disabled
// state. Stacking opacity on top of colour changes caused double-dimming where
// a disabled+checked box was nearly invisible. The Pressable's native
// disabled handling provides the interaction-level feedback.

const Label = styled.Text<{
  $labelPosition: 'left' | 'right' | 'top' | 'bottom';
  $fontScale:     number;
  $disabled:      boolean;
}>`
  color: ${({ theme, $disabled }) =>
    $disabled ? theme.colorTextSecondary : theme.colorText};
  font-size:   ${({ $fontScale }) => 14 * $fontScale}px;
  line-height: ${({ $fontScale }) => 20 * $fontScale}px;
  flex-shrink: 1;
  margin-left:  ${({ $labelPosition }) =>
    $labelPosition === 'right'  ? 10 : 0}px;
  margin-right: ${({ $labelPosition }) =>
    $labelPosition === 'left'   ? 10 : 0}px;
  margin-top:   ${({ $labelPosition }) =>
    $labelPosition === 'bottom' ? 4  : 0}px;
  margin-bottom: ${({ $labelPosition }) =>
    $labelPosition === 'top'    ? 4  : 0}px;
  text-align: ${({ $labelPosition }) =>
    $labelPosition === 'top' || $labelPosition === 'bottom' ? 'center' : 'left'};
`;
// Note: margins used instead of gap/column-gap for broader React Native
// version compatibility (gap support is inconsistent in RN < 0.71).