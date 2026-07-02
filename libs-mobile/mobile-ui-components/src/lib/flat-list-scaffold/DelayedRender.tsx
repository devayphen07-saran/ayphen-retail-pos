import { useEffect, useState, type ReactNode } from 'react';

/**
 * Renders nothing for `delay` ms, then mounts children. Used to avoid the
 * flash-of-loading state when queries resolve quickly (e.g., warm cache, fast
 * network). If the parent unmounts/changes state before the delay elapses,
 * children never appear and no jitter is seen.
 */
export function DelayedRender({
  delay = 200,
  children,
}: {
  delay?: number;
  children: ReactNode;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  return show ? <>{children}</> : null;
}