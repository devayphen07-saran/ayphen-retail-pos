import { RequirePermission } from '@core/auth/RequirePermission';
import { EditLocationScreen } from '@features/store/locations/screens/EditLocationScreen';

export default function LocationEditRoute() {
  return (
    <RequirePermission entity="Location" action="edit">
      <EditLocationScreen />
    </RequirePermission>
  );
}
