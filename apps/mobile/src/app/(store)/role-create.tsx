import { RequirePermission } from '@core/auth/RequirePermission';
import { CreateRoleScreen } from '@features/store/roles/screens/CreateRoleScreen';

export default function RoleCreateRoute() {
  return (
    <RequirePermission entity="Role" action="create">
      <CreateRoleScreen />
    </RequirePermission>
  );
}
