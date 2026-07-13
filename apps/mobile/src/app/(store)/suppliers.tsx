import { RequirePermission } from '@core/auth/RequirePermission';
import { SuppliersScreen } from '@features/suppliers/screens/SuppliersScreen';

export default function SuppliersRoute() {
  return (
    <RequirePermission entity="Supplier" action="view">
      <SuppliersScreen />
    </RequirePermission>
  );
}