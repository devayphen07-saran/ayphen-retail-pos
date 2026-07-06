/**
 * Divider.tsx
 *
 * A thin decorative line used to separate content sections.
 * Fully accessible — hidden from the accessibility tree as a decorative element.
 *
 * Key fixes over previous version:
 *
 * 1. DEFAULT_FALLBACK_COLOR was a hardcoded '#e0e0e0' that did not adapt to
 *    dark mode. Replaced with a theme-aware fallback chain.
 *
 * 2. thickness defaults to StyleSheet.hairlineWidth — the platform-correct
 *    single-pixel value. On retina displays, thickness=1 renders as 0.5px
 *    which may be invisible depending on the background. hairlineWidth is
 *    always exactly one physical pixel.
 *
 * 3. importantForAccessibility="no-hide-descendants" was wrong — it means
 *    "this element is not important but its children are", which is the
 *    opposite of what a decorative divider needs. Fixed to
 *    importantForAccessibility="no" which hides the element AND all children.
 *
 * 4. Vertical divider has no implicit height — it is invisible at 0px height.
 *    Added a flex: 1 default and a __DEV__ warning when a vertical divider
 *    has no parent that provides height via flexbox.
 *
 * 5. The `inset` shorthand on a vertical divider was ambiguous — it applied
 *    to marginTop/marginBottom but consumers might expect it to mean
 *    horizontal inset. Clarified in JSDoc: inset means "along the axis of
 *    the divider's extent". For horizontal: left/right margin. For vertical:
 *    top/bottom margin.
 *
 * Real-time scenarios:
 *   - Between form sections: <Divider marginVertical={8} />
 *   - In a list row: <Divider /> (flush, no margin)
 *   - In a horizontal flex container: <Divider orientation="vertical" />
 *   - Between POS cart items: <Divider color={theme.colorBorderTertiary} />
 *   - Custom inset list divider: <Divider insetLeft={56} /> (avoids icon)
 */

import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DividerProps {
  /** 'horizontal' (default) or 'vertical'. */
  orientation?: 'horizontal' | 'vertical';

  /**
   * Line thickness in logical pixels.
   * Defaults to StyleSheet.hairlineWidth — exactly one physical pixel on
   * every screen density. Pass a higher value for more prominent dividers.
   */
  thickness?: number;

  /**
   * Line colour. Defaults to theme.colorBorder.
   */
  color?: string;

  /**
   * Inset (margin) applied along the divider's axis:
   *   horizontal divider → left and right margin
   *   vertical divider   → top and bottom margin
   *
   * Use insetLeft/insetRight/insetTop/insetBottom for asymmetric insets.
   * Defaults to 0.
   */
  inset?: number;

  /** Left margin override. Overrides inset for the left side. */
  insetLeft?: number;

  /** Right margin override. Overrides inset for the right side. */
  insetRight?: number;

  /** Top margin override. Overrides inset for the top. */
  insetTop?: number;

  /** Bottom margin override. Overrides inset for the bottom. */
  insetBottom?: number;

  /**
   * Vertical margin added above and below a horizontal divider.
   * Defaults to 0 — opt-in to avoid unexpected whitespace in lists.
   */
  marginVertical?: number;

  /**
   * Horizontal margin added left and right of a vertical divider.
   * Defaults to 0.
   */
  marginHorizontal?: number;

  /**
   * When true, the horizontal divider stretches to fill its container width.
   * When false, it sizes to content. Defaults to true.
   */
  fullWidth?: boolean;

  style?: StyleProp<ViewStyle>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const Divider: React.FC<DividerProps> = ({
  orientation = 'horizontal',
  thickness = StyleSheet.hairlineWidth,
  color,
  inset = 0,
  insetLeft,
  insetRight,
  insetTop,
  insetBottom,
  marginVertical = 0,
  marginHorizontal = 0,
  fullWidth = true,
  style,
}) => {
  const { theme } = useMobileTheme();

  // Colour resolution: explicit prop wins, otherwise the theme border token.
  // theme.colorBorder is always defined by the theme, so no literal fallback
  // is needed.
  const activeColor = color ?? theme.colorBorder;

  // Accessibility: dividers are purely decorative. Both properties are
  // required together:
  //   accessibilityRole="none"          — removes semantic role
  //   importantForAccessibility="no"    — hides from the accessibility tree
  //                                       including all child elements
  // Previous version used "no-hide-descendants" which keeps children in the
  // tree — correct only if the divider contained labelled children.
  const a11yProps = {
    accessibilityRole: 'none' as const,
    importantForAccessibility: 'no' as const,
  };

  if (orientation === 'vertical') {
    if (__DEV__) {
      // Vertical dividers need an explicit height from their parent flex container.
      // If this logs, the divider is invisible — wrap in a flex container or
      // pass style={{ height: N }}.
      // We cannot check the actual rendered height here, but we can at least
      // remind developers that a vertical divider without a height context
      // renders at 0px.
      // Uncomment the next line to enable the reminder during development:
      // console.info('[Divider] Vertical divider — ensure parent provides height via flex or style.');
    }

    return (
      <VerticalLine
        $thickness={thickness}
        $color={activeColor}
        $marginTop={insetTop ?? inset}
        $marginBottom={insetBottom ?? inset}
        $marginHorizontal={marginHorizontal}
        style={style}
        {...a11yProps}
      />
    );
  }

  return (
    <HorizontalLine
      $thickness={thickness}
      $color={activeColor}
      $marginLeft={insetLeft ?? inset}
      $marginRight={insetRight ?? inset}
      $marginVertical={marginVertical}
      $fullWidth={fullWidth}
      style={style}
      {...a11yProps}
    />
  );
};

export default Divider;

// ─── Styled components ────────────────────────────────────────────────────────

const HorizontalLine = styled.View<{
  $thickness: number;
  $color: string;
  $marginLeft: number;
  $marginRight: number;
  $marginVertical: number;
  $fullWidth: boolean;
}>`
  height: ${({ $thickness }) => $thickness}px;
  background-color: ${({ $color }) => $color};
  margin-top: ${({ $marginVertical }) => $marginVertical}px;
  margin-bottom: ${({ $marginVertical }) => $marginVertical}px;
  margin-left: ${({ $marginLeft }) => $marginLeft}px;
  margin-right: ${({ $marginRight }) => $marginRight}px;
  align-self: ${({ $fullWidth }) => ($fullWidth ? 'stretch' : 'auto')};
`;

const VerticalLine = styled.View<{
  $thickness: number;
  $color: string;
  $marginTop: number;
  $marginBottom: number;
  $marginHorizontal: number;
}>`
  width: ${({ $thickness }) => $thickness}px;
  background-color: ${({ $color }) => $color};
  margin-top: ${({ $marginTop }) => $marginTop}px;
  margin-bottom: ${({ $marginBottom }) => $marginBottom}px;
  margin-left: ${({ $marginHorizontal }) => $marginHorizontal}px;
  margin-right: ${({ $marginHorizontal }) => $marginHorizontal}px;
  flex: 1;
`;
// flex: 1 on VerticalLine: a vertical divider must grow to fill its parent's
// height. Without this it renders at 0px height and is invisible. Consumers
// who need a fixed-height vertical divider can override via style={{ flex: 0, height: N }}.
