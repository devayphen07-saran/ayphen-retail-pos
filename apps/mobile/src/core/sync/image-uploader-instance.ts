/**
 * Wake registry for the background image uploader (image-offline-architecture.md
 * §C5/Step 6). Capture and other triggers call `requestImageUpload()`; the
 * uploader registers itself via `setImageUploader()` at store-open and clears it
 * on store-close. Decoupled through this module so the capture flow (Step 4) can
 * ship before the uploader (Step 6) exists — until an uploader is registered,
 * every call here is a safe no-op (the same shape as `scheduler-instance.ts`).
 */
export interface ImageUploaderHandle {
  /** Nudge the drain loop (after a capture, on reconnect, on foreground). */
  wake(): void;
  /** Bulk-requeue `blocked` rows → `pending_upload` (subscription reactivated — P1-14). */
  requeueBlocked(): void;
}

let uploader: ImageUploaderHandle | null = null;

export function setImageUploader(handle: ImageUploaderHandle | null): void {
  uploader = handle;
}

/** Best-effort nudge — UI never depends on it; the uploader's own triggers are the fallback. */
export function requestImageUpload(): void {
  uploader?.wake();
}

/** Called when a subscription reactivates so gated photos retry with no user tap. */
export function requeueBlockedImages(): void {
  uploader?.requeueBlocked();
}
