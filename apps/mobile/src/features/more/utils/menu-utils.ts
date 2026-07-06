import type { MobileTheme } from '@ayphen/mobile-theme';
import type { MenuColorToken } from './menu-config';

/**
 * Menu items with a real destination screen (pushed from MoreSectionScreen).
 * Everything else falls through to the generic "Coming soon" placeholder.
 */
export const ITEM_ROUTES: Partial<Record<string, string>> = {
  locations: '/(store)/locations',
  roles: '/(store)/roles',
  'invite-staff': '/(store)/invite-staff',
  invitations: '/(onboarding)/invitations',
  'my-devices': '/(store)/my-devices',
};

export function resolveMenuColor(theme: MobileTheme, token: MenuColorToken): string {
  switch (token) {
    case 'primary': return theme.colorPrimary;
    case 'success': return theme.colorSuccess;
    case 'warning': return theme.colorWarning;
    case 'error':   return theme.colorError;
    case 'info':    return theme.color?.blue?.main ?? '#2563EB';
    case 'violet':  return theme.color?.violet?.main ?? '#7C3AED';
    case 'teal':    return '#14B8A6';
    case 'neutral':
    default:        return '#64748B';
  }
}
