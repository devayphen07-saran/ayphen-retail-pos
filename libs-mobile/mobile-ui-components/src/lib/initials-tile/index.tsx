import React from 'react';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Typography } from '../typography';

interface InitialsTileProps {
  text?: string | null;
  size: number;
  borderRadius?: number;
  /** Override the deterministic palette pick. */
  bgColor?: string;
  textColor?: string;
}

// Tile palette chosen for accessibility (WCAG AA against #ffffff text) and
// brand neutrality. Pick is deterministic by a sum-of-codepoints hash so a
// given name always lands on the same color across renders / sessions.
// INTENTIONAL EXCEPTION to the design-token rule: this is a fixed, deterministic
// avatar palette with no theme-token equivalent, so the hex values stay inline.
export const INITIALS_PALETTE = [
  '#4F46E5', // indigo
  '#7C3AED', // violet
  '#0891B2', // cyan
  '#059669', // emerald
  '#D97706', // amber
  '#DC2626', // red
  '#DB2777', // pink
  '#0F766E', // teal
];

export function pickInitialsColor(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash + text.charCodeAt(i)) | 0;
  }
  return INITIALS_PALETTE[Math.abs(hash) % INITIALS_PALETTE.length];
}

export function extractInitials(text: string): string {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) {
    const word = parts[0];
    return (word[0] + (word[1] ?? '')).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Always-renderable placeholder for missing images. Two letters on a colored
 * tile — never a broken-image glyph. The color is deterministic per `text`
 * so the same user/product/store always looks the same.
 */
export const InitialsTile: React.FC<InitialsTileProps> = ({
  text,
  size,
  borderRadius,
  bgColor,
  textColor,
}) => {
  const { theme } = useMobileTheme();
  const resolvedTextColor = textColor ?? theme.colorWhite;
  const safeText = text && text.trim().length > 0 ? text : '?';
  const initials = extractInitials(safeText);
  const resolvedBg = bgColor ?? pickInitialsColor(safeText);
  // Scale font ~40% of tile so it stays readable from a 24-px favicon up to
  // a 200-px hero avatar without per-call tuning.
  const fontSize = Math.max(10, Math.round(size * 0.4));

  return (
    <Tile
      $size={size}
      $borderRadius={borderRadius ?? size / 2}
      $bg={resolvedBg}
    >
      <Typography.Body
        weight="semiBold"
        color={resolvedTextColor}
        style={{ fontSize, lineHeight: fontSize * 1.1 }}
      >
        {initials}
      </Typography.Body>
    </Tile>
  );
};

const Tile = styled.View<{ $size: number; $borderRadius: number; $bg: string }>`
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  border-radius: ${({ $borderRadius }) => $borderRadius}px;
  background-color: ${({ $bg }) => $bg};
  align-items: center;
  justify-content: center;
  overflow: hidden;
`;