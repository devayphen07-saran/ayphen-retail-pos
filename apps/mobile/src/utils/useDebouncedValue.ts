import { useEffect, useState } from 'react';

/** Returns `value`, but only updates after `delayMs` of no further change —
 *  coalesces a burst of rapid updates (keystrokes, a live-query firing once
 *  per row during a sync batch) into a single trailing-edge commit instead of
 *  re-rendering on every intermediate value. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}