import { RequirePermission } from '@core/auth/RequirePermission';
import { CreateSupplierScreen } from '@features/suppliers/screens/CreateSupplierScreen';

export default function SupplierCreateRoute() {
  return (
    <RequirePermission entity="Supplier" action="create">
      <CreateSupplierScreen />
    </RequirePermission>
  );
}