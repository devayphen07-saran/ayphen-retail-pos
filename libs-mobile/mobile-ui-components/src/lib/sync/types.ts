export type SyncStatus =
  | "idle"
  | "syncing"
  | "synced"
  | "queued"
  | "error"
  | "offline";

export interface SyncStatusVisual {
  label: string;
  iconName: import("../lucide-icon").LucideIconNameType;
  /**
   * Maps to the semantic color groups available in mobile-theme. Components
   * resolve `theme.color[tone].{bg, text, border, main}` from this.
   */
  tone: "primary" | "blue" | "green" | "orange" | "red" | "grey" | "success" | "warning" | "danger";
}

export const SYNC_STATUS_VISUALS: Record<SyncStatus, SyncStatusVisual> = {
  idle: { label: "Up to date", iconName: "Check", tone: "grey" },
  syncing: { label: "Syncing", iconName: "RefreshCw", tone: "blue" },
  synced: { label: "Synced", iconName: "CheckCheck", tone: "success" },
  queued: { label: "Pending", iconName: "Clock", tone: "warning" },
  error: { label: "Sync failed", iconName: "TriangleAlert", tone: "danger" },
  offline: { label: "Offline", iconName: "WifiOff", tone: "grey" },
};