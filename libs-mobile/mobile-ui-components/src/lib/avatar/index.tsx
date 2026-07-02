/**
 * Avatar.tsx
 *
 * Displays a user or entity avatar in one of four modes (priority order):
 *   1. loading   — ActivityIndicator
 *   2. uri       — remote or local image
 *   3. initials  — up to 2 characters from the initials string
 *   4. iconName  — a named Lucide icon
 *   5. fallback  — the "User" Lucide icon
 *
 * Interaction:
 *   - onPress provided  → renders TouchableOpacity with button role
 *   - onPress absent    → renders a plain View (no false press affordance)
 *
 * Accessibility:
 *   - Loading state announces "Loading"
 *   - Image announces via accessibilityLabel (defaults to "Avatar")
 *   - Initials announces the full initials string to screen readers
 *   - Tappable avatars announce as role="button"
 *   - Disabled state is reflected in accessibilityState
 *   - Status dot announces "active" or "inactive" as accessibilityLabel
 *
 * Real-time scenarios covered:
 *   - Staff list: uri image with active/inactive status dot
 *   - Customer selector: initials with colorType-based background
 *   - POS header: small icon-only avatar (24px) with onPress → profile sheet
 *   - Group avatar: square shape with icon
 *   - Loading skeleton: loading=true while image URL is being fetched
 *   - Disabled: e.g. inactive staff member — dimmed, not pressable
 *   - Tablet: $scale applied to border-radius and status dot size
 */

import React from 'react';
import {
  AccessibilityState,
  ActivityIndicator,
  TouchableOpacity,
  ViewProps,
} from 'react-native';
import styled from 'styled-components/native';
import { ColorType, useMobileTheme, useBreakpoint } from '@nks/mobile-theme';
import { LucideIcon, LucideIconNameType } from '../lucide-icon';
import { Typography } from '../typography';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AvatarProps extends ViewProps {
  // ── Content (priority order) ───────────────────────────────────────────────
  /** Remote or local image URI. Rendered first if provided. */
  uri?: string;

  /**
   * Up to 2 characters shown as initials. If more than 2 characters are
   * provided, only the first two are used. Always uppercased.
   */
  initials?: string;

  /** Named Lucide icon shown when no uri or initials are provided. */
  iconName?: LucideIconNameType;

  /** Colour of the icon. Defaults to the resolved text colour for the colorType. */
  iconColor?: string;

  // ── Appearance ─────────────────────────────────────────────────────────────
  /** Diameter in logical pixels. Scales with the breakpoint scale by default. */
  size?: number;

  /** Explicit background colour. Overrides colorType. */
  bgColor?: string;

  /**
   * Theme colour ramp used for background and text/icon colour.
   * Ignored when bgColor or iconColor are explicitly set.
   */
  colorType?: ColorType;

  /** 'circle' (default) or 'square' with rounded corners. */
  shape?: 'circle' | 'square';

  /**
   * Whether to show a coloured status indicator dot.
   * 'active' → colorSuccess. 'inactive' → colorError.
   */
  status?: 'active' | 'inactive';

  /** When true, shows an ActivityIndicator instead of any other content. */
  loading?: boolean;

  // ── Border ─────────────────────────────────────────────────────────────────
  /**
   * When true, renders a border around the avatar.
   * Default: false. For image avatars the border is a subtle separator ring —
   * set showBorder=true explicitly if you want it.
   */
  showBorder?: boolean;

  /** Border width in pixels. Only applied when showBorder=true. Default: 2. */
  borderWidth?: number;

  /** Border colour. Defaults to theme.colorBorderSecondary. */
  borderColor?: string;

  // ── Interaction ────────────────────────────────────────────────────────────
  /**
   * When provided, the avatar becomes a TouchableOpacity with role="button".
   * When absent, the avatar renders as a plain View (no press affordance).
   */
  onPress?: () => void;

  /** Disables interaction and dims the avatar. */
  disabled?: boolean;

  // ── Accessibility ──────────────────────────────────────────────────────────
  /**
   * Label announced to screen readers.
   * Defaults to the initials string, or "Avatar" if no initials.
   */
  accessibilityLabel?: string;

  /** Hint announced after the label. E.g. "Opens profile sheet". */
  accessibilityHint?: string;

  // ── Testing ────────────────────────────────────────────────────────────────
  testID?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const Avatar: React.FC<AvatarProps> = ({
  uri,
  initials,
  size: sizeProp,
  style,
  colorType,
  iconName,
  iconColor,
  onPress,
  disabled = false,
  shape = 'circle',
  bgColor,
  status,
  loading = false,
  borderWidth,
  borderColor,
  showBorder = false,
  accessibilityLabel: a11yLabelOverride,
  accessibilityHint,
  testID,
  ...rest
}) => {
  const { theme } = useMobileTheme();
  const { scale } = useBreakpoint();

  // Apply scale to the default size so avatars grow proportionally on tablets.
  // Explicit sizeProp bypasses scale — the consumer takes full responsibility.
  const size = sizeProp ?? Math.round(40 * scale);

  // ── Initials — take exactly 2 characters, uppercase ───────────────────────
  // "john doe" → "JO", "AB" → "AB", "A" → "A"
  // We take [0] and [1] — if only one character is provided we show just that.
  const avatarInitials = initials
    ? initials.slice(0, 2).toUpperCase()
    : undefined;

  // ── Colour resolution ──────────────────────────────────────────────────────
  const resolvedColorType = colorType ?? ColorType.primary;

  // Warn in dev when the theme colour map is missing for the requested type.
  if (__DEV__ && colorType && !theme.color?.[resolvedColorType]) {
    console.warn(
      `[Avatar] theme.color.${resolvedColorType} is undefined. ` +
        'Check that the theme includes this ColorType.',
    );
  }

  const backgroundColor =
    bgColor ?? theme.color?.[resolvedColorType]?.bg ?? theme.colorBgContainer;

  const resolvedTextColor =
    theme.color?.[resolvedColorType]?.main ?? theme.colorText;

  // iconColor prop explicitly overrides the resolved text colour.
  // Both the named icon and the fallback User icon use the same source
  // so there is no inconsistency between the two cases.
  const resolvedIconColor = iconColor ?? resolvedTextColor;

  // ── Border ─────────────────────────────────────────────────────────────────
  // showBorder must be explicitly set to true to show any border.
  // The original code showed a 1px border on image avatars by default —
  // that was removed because it was implicit and often unwanted.
  const resolvedBorderWidth = showBorder ? (borderWidth ?? 2) : 0;
  const resolvedBorderColor = borderColor ?? theme.colorBorderSecondary;

  // ── Status dot geometry ────────────────────────────────────────────────────
  // Clamped between 8px and 16px so the dot is always visible and never
  // overwhelms the avatar at extreme sizes (16px or 120px avatars).
  const statusDotSize = Math.round(Math.max(8, Math.min(size * 0.28, 16)));

  // The dot sits at the bottom-right corner of the avatar bounding box.
  // For circles: offset inward by half the dot size so the dot centre sits on
  //   the circle's perimeter — this is the standard avatar status convention.
  // For squares: offset slightly outward (-2px) so the dot peeks outside.
  const dotOffset =
    shape === 'circle'
      ? Math.round(-(statusDotSize / 2)) // negative = moves into the avatar
      : -2;

  // ── Accessibility ──────────────────────────────────────────────────────────
  const a11yLabel =
    a11yLabelOverride ??
    (loading
      ? 'Loading'
      : initials
        ? initials // announce the full initials string, not just 2 chars
        : 'Avatar');

  const a11yState: AccessibilityState = {
    disabled,
    busy: loading,
  };

  // ── Inner content ──────────────────────────────────────────────────────────
  const content = loading ? (
    <ActivityIndicator
      color={resolvedTextColor}
      size="small"
      accessibilityLabel="Loading"
    />
  ) : uri ? (
    <StyledImage
      source={{ uri }}
      $size={size}
      $shape={shape}
      $scale={scale}
      accessibilityRole="image"
      accessibilityLabel={a11yLabel}
    />
  ) : avatarInitials ? (
    <InitialsText $color={resolvedTextColor} $fontSize={size * 0.38}>
      {avatarInitials}
    </InitialsText>
  ) : iconName ? (
    <LucideIcon name={iconName} color={resolvedIconColor} size={size * 0.55} />
  ) : (
    <LucideIcon name="User" color={resolvedIconColor} size={size * 0.55} />
  );

  // ── Container — TouchableOpacity when pressable, View otherwise ────────────
  // Rendering a TouchableOpacity with no onPress creates a false affordance:
  // the element announces as a "button" to screen readers even when nothing
  // happens on tap. A plain View is the correct element for non-interactive avatars.
  const containerProps = {
    $size: size,
    $shape: shape,
    $backgroundColor: backgroundColor,
    $borderWidth: resolvedBorderWidth,
    $borderColor: resolvedBorderColor,
    $scale: scale,
    accessibilityLabel: a11yLabel,
    accessibilityHint,
    accessibilityState: a11yState,
    testID,
  };

  return (
    <AvatarWrapper $size={size} style={style} {...rest}>
      {onPress ? (
        <PressableContainer
          {...containerProps}
          onPress={onPress}
          disabled={disabled}
          activeOpacity={0.7}
          accessibilityRole="button"
        >
          {content}
        </PressableContainer>
      ) : (
        <StaticContainer
          {...containerProps}
          accessibilityRole={uri ? 'image' : 'none'}
        >
          {content}
        </StaticContainer>
      )}

      {status && !loading && (
        <StatusDot
          $size={statusDotSize}
          $offset={dotOffset}
          $color={status === 'active' ? theme.colorSuccess : theme.colorError}
          accessibilityLabel={status === 'active' ? 'Active' : 'Inactive'}
          accessible
        />
      )}
    </AvatarWrapper>
  );
};

export default Avatar;

// ─── Shared container styles ──────────────────────────────────────────────────
//
// Both the pressable and static containers share the same visual appearance.
// The only difference is the underlying element type (TouchableOpacity vs View).
// We define the styles once via a shared prop interface and apply them to both.

interface ContainerStyleProps {
  $size: number;
  $shape: 'circle' | 'square';
  $backgroundColor: string;
  $borderWidth: number;
  $borderColor: string;
  $scale: number;
}

const containerCss = ({
  $size,
  $shape,
  $backgroundColor,
  $borderWidth,
  $borderColor,
  $scale,
}: ContainerStyleProps) => `
  width:            ${$size}px;
  height:           ${$size}px;
  border-radius:    ${$shape === 'circle' ? $size / 2 : Math.round(8 * $scale)}px;
  background-color: ${$backgroundColor};
  align-items:      center;
  justify-content:  center;
  overflow:         hidden;
  border-width:     ${$borderWidth}px;
  border-color:     ${$borderColor};
`;

// Pressable variant — wraps TouchableOpacity
const PressableContainer = styled(TouchableOpacity)<ContainerStyleProps>`
  ${(props) => containerCss(props)}
`;

// Static variant — wraps View
const StaticContainer = styled.View<ContainerStyleProps>`
  ${(props) => containerCss(props)}
`;

// ─── AvatarWrapper ────────────────────────────────────────────────────────────
//
// The outer View holds both the container and the absolute-positioned status dot.
// position: relative is the React Native default and is a no-op — it is kept
// explicitly as a reminder that the StatusDot uses position: absolute relative
// to this wrapper.

const AvatarWrapper = styled.View<{ $size: number }>`
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
`;

// ─── StyledImage ──────────────────────────────────────────────────────────────
//
// $scale is used for border-radius on square images so the rounded corner
// scales proportionally on tablets.

const StyledImage = styled.Image<{
  $size: number;
  $shape: 'circle' | 'square';
  $scale: number;
}>`
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  border-radius: ${({ $size, $shape, $scale }) =>
    $shape === 'circle' ? $size / 2 : Math.round(8 * $scale)}px;
`;

// ─── InitialsText ─────────────────────────────────────────────────────────────
//
// Typography.H5 carries its own line-height which causes vertical misalignment
// when centred inside a fixed-size circle. Setting line-height equal to the
// font-size (1:1 ratio) and using the container's align-items: center for
// vertical positioning produces pixel-accurate centring on both iOS and Android.

const InitialsText = styled(Typography.H5)<{
  $color: string;
  $fontSize: number;
}>`
  color: ${({ $color }) => $color};
  font-size: ${({ $fontSize }) => $fontSize}px;
  line-height: ${({ $fontSize }) => $fontSize}px;
  font-family: ${({ theme }) => theme.fontFamily.poppinsBold};
  include-font-padding: false;
`;

// ─── StatusDot ────────────────────────────────────────────────────────────────
//
// Positioned at the bottom-right corner of the AvatarWrapper.
// $offset: negative = moves dot inward toward the centre of the circle edge
//          positive = moves dot outward beyond the avatar boundary (square mode)
//
// The white border (colorWhite) creates separation between the dot and the
// avatar image so the dot is readable on any background.

const StatusDot = styled.View<{
  $size: number;
  $offset: number;
  $color: string;
}>`
  position: absolute;
  bottom: ${({ $offset }) => $offset}px;
  right: ${({ $offset }) => $offset}px;
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  border-radius: ${({ $size }) => $size / 2}px;
  border-width: ${({ theme }) => theme.borderWidth.light}px;
  border-color: ${({ theme }) => theme.colorWhite};
  background-color: ${({ $color }) => $color};
`;
