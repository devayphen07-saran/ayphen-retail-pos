import { RequirePermission } from '@core/auth/RequirePermission';
import { CreateLocationScreen } from '@features/store/locations/screens/CreateLocationScreen';

export default function LocationCreateRoute() {
  return (
    <RequirePermission entity="Location" action="create">
      <CreateLocationScreen />
    </RequirePermission>
  );
}
