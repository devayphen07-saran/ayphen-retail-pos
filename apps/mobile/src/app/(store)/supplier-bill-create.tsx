import { useLocalSearchParams } from 'expo-router';
import { RequirePermission } from '@core/auth/RequirePermission';
import { CreateSupplierBillScreen } from '@features/suppliers/screens/CreateSupplierBillScreen';

type Params = { supplierId: string; supplierGuuid: string };

export default function SupplierBillCreateRoute() {
  const { supplierId, supplierGuuid } = useLocalSearchParams<Params>();
  return (
    <RequirePermission entity="SupplierBill" action="create">
      <CreateSupplierBillScreen supplierId={supplierId} supplierGuuid={supplierGuuid} />
    </RequirePermission>
  );
}