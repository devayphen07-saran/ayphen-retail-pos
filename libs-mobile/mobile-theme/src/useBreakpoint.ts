import { useMemo } from "react";
import { useWindowDimensions } from "react-native";
import {
  type Breakpoint,
  breakpoints,
  deviceScale,
  fontScale,
  resolveBreakpoint,
} from "./tokens/breakpoints";

export interface BreakpointInfo {
  /** Resolved breakpoint name based on the current window width. */
  breakpoint: Breakpoint;
  /** Current window width in dp. */
  width: number;
  /** Current window height in dp. */
  height: number;
  isPhone: boolean;
  isTablet: boolean;
  isLargeTablet: boolean;
  /** Multiplier for spacing, padding, and component dimensions. */
  scale: number;
  /** Multiplier for font sizes (more conservative than `scale`). */
  fontScale: number;
}

export function useBreakpoint(): BreakpointInfo {
  const { width, height } = useWindowDimensions();

  return useMemo<BreakpointInfo>(() => {
    const breakpoint = resolveBreakpoint(width);
    return {
      breakpoint,
      width,
      height,
      isPhone: breakpoint === "phone",
      isTablet: breakpoint === "tablet" || breakpoint === "largeTablet",
      isLargeTablet: breakpoint === "largeTablet",
      scale: deviceScale[breakpoint],
      fontScale: fontScale[breakpoint],
    };
  }, [width, height]);
}

export type ResponsiveValue<T> = {
  phone: T;
  tablet?: T;
  largeTablet?: T;
};

/** Pick a value based on the current breakpoint, falling back through tablet -> phone. */
export function useResponsiveValue<T>(values: ResponsiveValue<T>): T {
  const { breakpoint } = useBreakpoint();
  if (breakpoint === "largeTablet") {
    return values.largeTablet ?? values.tablet ?? values.phone;
  }
  if (breakpoint === "tablet") {
    return values.tablet ?? values.phone;
  }
  return values.phone;
}

/** Multiply a base size by the device scale (rounded to nearest integer). */
export function useScaledSize(base: number): number {
  const { scale } = useBreakpoint();
  return Math.round(base * scale);
}

/** Multiply a base font size by the font scale (rounded to nearest integer). */
export function useScaledFont(base: number): number {
  const { fontScale: fs } = useBreakpoint();
  return Math.round(base * fs);
}

export { breakpoints, deviceScale, fontScale, resolveBreakpoint };
export type { Breakpoint };
