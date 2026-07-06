import type { ReactNode } from 'react';
import { Redirect } from 'expo-router';
import { usePermission } from './usePermission';

/**
 * Route-level RBAC guard (navigation-agent.md §8 level 2 / golden rule 6) —
 * the security boundary, not just a hidden button. `usePermission` selects
 * off the live snapshot, so a mid-session permission downgrade re-evaluates
 * this on the next render and evicts the user automatically, same as
 * `AuthGate` does for session loss.
 */
export function RequirePermission({
  entity,
  action,
  fallbackHref = '/(store)',
  children,
}: {
  entity: string;
  action: string;
  fallbackHref?: string;
  children: ReactNode;
}) {
  const allowed = usePermission(entity, action);
  if (!allowed) return <Redirect href={fallbackHref} />;
  return <>{children}</>;
}
