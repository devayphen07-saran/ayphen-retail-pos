import type { MobileTheme } from '@ayphen/mobile-theme';
import type { MenuColorToken } from './menu-config';

/**
 * Menu items with a real destination screen (pushed from MoreSectionScreen).
 * Everything else falls through to the generic "Coming soon" placeholder.
 */
export const ITEM_ROUTES: Partial<Record<string, string>> = {
  roles: '/(store)/roles',
  'invite-staff': '/(store)/invite-staff',
  invitations: '/(onboarding)/invitations',
  'my-devices': '/(store)/my-devices',
  'sessions': '/(store)/sessions',
  'sync-issues': '/(store)/sync-issues',
  'local-tables': '/(store)/local-tables',
};

export function resolveMenuColor(theme: MobileTheme, token: MenuColorToken): string {
  switch (token) {
    case 'primary': return theme.colorPrimary;
    case 'success': return theme.colorSuccess;
    case 'warning': return theme.colorWarning;
    case 'error':   return theme.colorError;
    case 'info':    return theme.color.blue.main;
    case 'violet':  return theme.color.violet.main;
    // 'teal' has no corresponding ColorVariantKey in mobile-theme yet (the
    // enumerated set is primary/secondary/success/danger/warning/blue/orange/
    // violet/green/red/grey/default) — adding one is a real token-schema
    // change (design-system-libs-agent.md §8: full ColorValueType in both
    // light+dark), out of scope for this pass. Falls back to the nearest
    // cool token rather than a hardcoded hex.
    case 'teal':    return theme.color.blue.main;
    case 'neutral':
    default:        return theme.color.grey.main;
  }
}

/** The tinted-background counterpart to `resolveMenuColor` — same token per
 *  color, its semantic `.bg` slot instead of `.main` (used for icon-chip
 *  backgrounds, replacing the `${hex}15`-style alpha-suffix hack). */
export function resolveMenuBg(theme: MobileTheme, token: MenuColorToken): string {
  switch (token) {
    case 'primary': return theme.color.primary.bg;
    case 'success': return theme.color.success.bg;
    case 'warning': return theme.color.warning.bg;
    case 'error':   return theme.color.danger.bg;
    case 'info':    return theme.color.blue.bg;
    case 'violet':  return theme.color.violet.bg;
    case 'teal':    return theme.color.blue.bg;
    case 'neutral':
    default:        return theme.color.grey.bg;
  }
}
