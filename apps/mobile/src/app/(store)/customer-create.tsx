import { RequirePermission } from '@core/auth/RequirePermission';
import { CreateCustomerScreen } from '@features/customers/screens/CreateCustomerScreen';

export default function CustomerCreateRoute() {
  return (
    <RequirePermission entity="Customer" action="create">
      <CreateCustomerScreen />
    </RequirePermission>
  );
}