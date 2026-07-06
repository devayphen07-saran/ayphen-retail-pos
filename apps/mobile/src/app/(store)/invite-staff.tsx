import { RequirePermission } from '@core/auth/RequirePermission';
import { InviteStaffScreen } from '@features/store/staff/screens/InviteStaffScreen';

export default function InviteStaffRoute() {
  return (
    <RequirePermission entity="Invitation" action="create">
      <InviteStaffScreen />
    </RequirePermission>
  );
}
