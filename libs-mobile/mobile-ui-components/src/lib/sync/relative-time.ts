/**
 * Lightweight "X seconds/minutes/hours ago" helper. Avoids pulling in moment/
 * date-fns for what is a single label in the UI.
 */
export function formatRelativeTime(
  fromMs: number | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (fromMs == null) return "never";
  const delta = Math.max(0, nowMs - fromMs);
  const sec = Math.floor(delta / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 4) return `${wk}w ago`;
  return new Date(fromMs).toLocaleDateString();
}