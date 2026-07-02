export const breakpoints = {
  phone: 0,
  tablet: 600,
  largeTablet: 1024,
} as const;

export type Breakpoint = keyof typeof breakpoints;

export function resolveBreakpoint(width: number): Breakpoint {
  if (width >= breakpoints.largeTablet) return "largeTablet";
  if (width >= breakpoints.tablet) return "tablet";
  return "phone";
}

export const deviceScale: Record<Breakpoint, number> = {
  phone: 1,
  tablet: 1.15,
  largeTablet: 1.25,
};

export const fontScale: Record<Breakpoint, number> = {
  phone: 1,
  tablet: 1.1,
  largeTablet: 1.15,
};
