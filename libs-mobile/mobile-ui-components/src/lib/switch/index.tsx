import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  StyleProp,
  ViewStyle,
  Pressable,
  AccessibilityProps,
} from 'react-native';
import styled from 'styled-components/native';
import {
  Controller,
  Control,
  FieldValues,
  Path,
  RegisterOptions,
} from 'react-hook-form';

import { Typography } from '../typography';
import { useMobileTheme, useBreakpoint } from '@ayphen/mobile-theme';

const ANIMATION_DURATION_MS = 180;
const BRAND_FALLBACK = '#2563eb';
const TRACK_OFF_FALLBACK = '#e5e7eb';
// THUMB_BORDER_FALLBACK: no token exists for this specific translucent thumb
// border — kept as-is to preserve the subtle depth effect on the switch thumb.
const THUMB_BORDER_FALLBACK = 'rgba(15, 23, 42, 0.08)';
const ERROR_FALLBACK = '#dc2626';

export interface SwitchProps<T extends FieldValues = FieldValues> {
  /** Uncontrolled initial value. Ignored when `checked` is provided. */
  defaultChecked?: boolean;
  /** Controlled value. When provided, component becomes fully controlled. */
  checked?: boolean;
  /** Fires with the new boolean value when the user toggles. */
  onValueChange?: (checked: boolean) => void;
  /** Disable interaction. Also dims the visual to signal non-interactive. */
  disabled?: boolean;
  /** Track width in px. Thumb sizes proportionally. */
  size?: number;
  /** Forwarded to the track element. */
  style?: StyleProp<ViewStyle>;
  /** Label text. When provided, layout follows `labelPosition`. */
  label?: string;
  labelPosition?: 'top' | 'left' | 'right';
  /** Marks the field as required (visual + a11y). */
  required?: boolean;
  /** Accessibility label override. Falls back to `label`. */
  accessibilityLabel?: string;
  /** Accessibility hint for screen readers. */
  accessibilityHint?: string;

  // ─── react-hook-form integration ─────────────────────────────────────
  /** Field name in the form. Required when using `control`. */
  name?: Path<T>;
  /** RHF control. When provided with `name`, the switch is RHF-controlled. */
  control?: Control<T>;
  /** RHF validation rules. */
  rules?: RegisterOptions<T, Path<T>>;
  /** Show an error message under the switch when RHF reports one. */
  error?: string;
}

export function Switch<T extends FieldValues = FieldValues>(
  props: SwitchProps<T>,
) {
  const { name, control, rules } = props;

  // RHF path uses Controller; the inner SwitchControl is the actual visual,
  // and hooks live there (NOT inside Controller's render prop).
  if (name && control) {
    return (
      <Controller
        name={name}
        control={control}
        rules={rules}
        render={({
          field: { value, onChange, onBlur },
          fieldState: { error },
        }) => (
          <SwitchControl
            {...props}
            checked={!!value}
            onValueChange={(next) => {
              onChange(next);
              props.onValueChange?.(next);
              onBlur();
            }}
            error={error?.message ?? props.error}
          />
        )}
      />
    );
  }

  // Non-RHF path. Same SwitchControl handles controlled and uncontrolled
  // via its own internal logic.
  return <SwitchControl {...props} />;
}

// ─── Inner component — owns all hooks, called as a real React component ─

function SwitchControl<T extends FieldValues>(props: SwitchProps<T>) {
  const {
    defaultChecked = false,
    checked: checkedProp,
    onValueChange,
    disabled = false,
    size: sizeProp,
    style,
    label,
    labelPosition = 'right',
    required = false,
    accessibilityLabel,
    accessibilityHint,
    error,
  } = props;

  const { theme } = useMobileTheme();
  const { scale } = useBreakpoint();

  const size = sizeProp ?? Math.round(40 * scale);
  const isControlled = checkedProp !== undefined;

  // Internal state only used when uncontrolled.
  const [internalChecked, setInternalChecked] = useState(defaultChecked);
  const currentChecked = isControlled ? !!checkedProp : internalChecked;

  // Track if this is the first render — skip the initial animation.
  const isFirstRender = useRef(true);

  // ─── Geometry (memoized so styled-components don't re-evaluate) ──────
  const dimensions = useMemo(() => {
    const trackWidth = size * 1.22;
    const trackHeight = size * 0.6;
    const thumbSize = size * 0.55;
    const trackPadding = Math.max(2, size * 0.05);
    const thumbTranslate = trackWidth - thumbSize - trackPadding * 2;
    return { trackWidth, trackHeight, thumbSize, trackPadding, thumbTranslate };
  }, [size]);

  // ─── Animation ───────────────────────────────────────────────────────
  // Animate translateX (not `left`) so we can use the native driver.
  const animValue = useRef(new Animated.Value(currentChecked ? 1 : 0)).current;

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      // Set position without animating on mount.
      animValue.setValue(currentChecked ? 1 : 0);
      return;
    }
    Animated.timing(animValue, {
      toValue: currentChecked ? 1 : 0,
      duration: ANIMATION_DURATION_MS,
      useNativeDriver: true,
    }).start();
  }, [currentChecked, animValue]);

  const thumbTranslateX = animValue.interpolate({
    inputRange: [0, 1],
    outputRange: [dimensions.trackPadding, dimensions.thumbTranslate],
  });

  // ─── Toggle handler ──────────────────────────────────────────────────
  const handleToggle = useCallback(() => {
    if (disabled) return;
    const next = !currentChecked;
    if (!isControlled) {
      setInternalChecked(next);
    }
    onValueChange?.(next);
  }, [disabled, currentChecked, isControlled, onValueChange]);

  // ─── Colors with proper fallback ─────────────────────────────────────
  const trackColorOn = theme.colorPrimary ?? BRAND_FALLBACK;
  const trackColorOff = theme.color?.grey?.active ?? TRACK_OFF_FALLBACK;
  const thumbColor = theme.colorWhite ?? '#ffffff';
  const thumbBorder = theme.color?.grey?.border ?? THUMB_BORDER_FALLBACK;
  const errorColor = theme.color?.red?.main ?? ERROR_FALLBACK;

  const trackColor = currentChecked ? trackColorOn : trackColorOff;

  // ─── Accessibility ───────────────────────────────────────────────────
  const a11yLabel = accessibilityLabel ?? label ?? 'Toggle';
  const accessibilityProps: AccessibilityProps = {
    accessibilityRole: 'switch',
    accessibilityLabel: a11yLabel,
    accessibilityHint: accessibilityHint,
    accessibilityState: {
      checked: currentChecked,
      disabled,
    },
  };

  // ─── Label rendering ─────────────────────────────────────────────────
  const labelElement = label ? (
    <Typography.Caption>
      {label}
      {required && (
        <RequiredMark $color={errorColor}> *</RequiredMark>
      )}
    </Typography.Caption>
  ) : null;

  // ─── Render ──────────────────────────────────────────────────────────
  return (
    <Container>
      <Wrapper $labelPosition={labelPosition}>
        {(labelPosition === 'top' || labelPosition === 'left') && labelElement}

        <Pressable
          onPress={handleToggle}
          disabled={disabled}
          hitSlop={8}
          {...accessibilityProps}
        >
          <Track
            $trackColor={trackColor}
            $width={dimensions.trackWidth}
            $height={dimensions.trackHeight}
            $disabled={disabled}
            style={style}
          >
            <Thumb
              $size={dimensions.thumbSize}
              $top={(dimensions.trackHeight - dimensions.thumbSize) / 2}
              $color={thumbColor}
              $borderColor={thumbBorder}
              style={{
                // translateX is a runtime Animated value — must stay inline
                transform: [{ translateX: thumbTranslateX }],
              }}
            />
          </Track>
        </Pressable>

        {labelPosition === 'right' && labelElement}
      </Wrapper>

      {error && (
        <ErrorText $color={errorColor}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          {error}
        </ErrorText>
      )}
    </Container>
  );
}

export default Switch;

// ─── Styles ──────────────────────────────────────────────────────────────

const Container = styled.View`
  align-self: flex-start;
`;

const Wrapper = styled.View<{ $labelPosition: 'top' | 'left' | 'right' }>`
  flex-direction: ${({ $labelPosition }) =>
    $labelPosition === 'top'
      ? 'column'
      : $labelPosition === 'left'
        ? 'row-reverse'
        : 'row'};
  align-items: ${({ $labelPosition }) =>
    $labelPosition === 'top' ? 'flex-start' : 'center'};
  gap: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const Track = styled.View<{
  $trackColor: string;
  $width: number;
  $height: number;
  $disabled: boolean;
}>`
  width: ${({ $width }) => $width}px;
  height: ${({ $height }) => $height}px;
  border-radius: ${({ $height }) => $height / 2}px;
  background-color: ${({ $trackColor }) => $trackColor};
  opacity: ${({ $disabled }) => ($disabled ? 0.5 : 1)};
  justify-content: center;
  position: relative;
`;

const Thumb = styled(Animated.View)<{
  $size: number;
  $top: number;
  $color: string;
  $borderColor: string;
}>`
  position: absolute;
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  top: ${({ $top }) => $top}px;
  left: 0;
  border-radius: ${({ $size }) => $size / 2}px;
  background-color: ${({ $color }) => $color};
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ $borderColor }) => $borderColor};
  elevation: 2;
  /* shadow-color: no token for translucent overlay — kept as rgba per design spec */
  shadow-color: rgba(15, 23, 42, 0.25);
  shadow-offset: 0px 2px;
  shadow-opacity: 0.3;
  shadow-radius: 3px;
`;

const RequiredMark = styled(Typography.Caption)<{ $color: string }>`
  color: ${({ $color }) => $color};
`;

const ErrorText = styled(Typography.Caption)<{ $color: string }>`
  color: ${({ $color }) => $color};
  margin-top: ${({ theme }) => theme.sizing.xxSmall}px;
`;
