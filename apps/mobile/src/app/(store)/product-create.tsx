import { RequirePermission } from '@core/auth/RequirePermission';
import { CreateProductScreen } from '@features/products/screens/CreateProductScreen';

export default function ProductCreateRoute() {
  return (
    <RequirePermission entity="Product" action="create">
      <CreateProductScreen />
    </RequirePermission>
  );
}
