import { RequirePermission } from '@core/auth/RequirePermission';
import { RolePermissionsScreen } from '@features/store/roles/screens/RolePermissionsScreen';

export default function RolePermissionsRoute() {
  return (
    <RequirePermission entity="Role" action="view">
      <RolePermissionsScreen />
    </RequirePermission>
  );
}
