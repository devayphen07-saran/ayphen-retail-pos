import { RequirePermission } from '@core/auth/RequirePermission';
import { LocationsScreen } from '@features/store/locations/screens/LocationsScreen';

export default function LocationsRoute() {
  return (
    <RequirePermission entity="Location" action="view">
      <LocationsScreen />
    </RequirePermission>
  );
}
