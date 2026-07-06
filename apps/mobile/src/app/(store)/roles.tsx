import { RequirePermission } from '@core/auth/RequirePermission';
import { RolesListScreen } from '@features/store/roles/screens/RolesListScreen';

export default function RolesRoute() {
  return (
    <RequirePermission entity="Role" action="view">
      <RolesListScreen />
    </RequirePermission>
  );
}
