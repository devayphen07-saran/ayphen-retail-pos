import type React from "react";

export type SnapPoint = "sm" | "md" | "lg" | "full";
// sm 35% · md 55% · lg 80% · full 100% — heights are read live from the window.

export interface BottomSheetConfig<P = any> {
  // ── Content (component + props — NEVER a rendered element) ──
  Component: React.ComponentType<P>;
  props?: P;

  // ── Snap ──
  snapPoint?: SnapPoint;             // single-snap; default 'md'
  multiSnap?: boolean;               // enables half→full
  initialSnap?: "half" | "full";     // multi-snap only; default 'half'

  // ── Header ──
  title?: string;
  subtitle?: string;

  // ── Behaviour ──
  showHandle?: boolean;              // default true
  closeOnBackdrop?: boolean;         // default true
  preventClose?: boolean;            // MANAGED — set only via runLocked; default false
  reduceMotion?: boolean;            // respect AccessibilityInfo; default auto

  // ── Callbacks ──
  onOpen?: () => void;               // after open animation
  onClose?: () => void;              // after close animation
}

export interface BottomSheetContextValue {
  open: <P>(config: BottomSheetConfig<P>) => void;
  close: () => void;
  updateConfig: (partial: Partial<BottomSheetConfig>) => void;
  /** Sets preventClose for the duration of fn and ALWAYS clears it (finally). */
  runLocked: <T>(fn: () => Promise<T>) => Promise<T>;
  isOpen: boolean;
}