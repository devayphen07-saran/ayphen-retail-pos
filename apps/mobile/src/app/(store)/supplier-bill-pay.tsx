import { useLocalSearchParams } from 'expo-router';
import { RequirePermission } from '@core/auth/RequirePermission';
import { PaySupplierBillScreen } from '@features/suppliers/screens/PaySupplierBillScreen';

type Params = {
  supplierId: string;
  supplierGuuid: string;
  billId: string;
  billGuuid: string;
  billNo: string;
  remainingPaise: string;
};

export default function SupplierBillPayRoute() {
  const { supplierId, supplierGuuid, billId, billGuuid, billNo, remainingPaise } = useLocalSearchParams<Params>();
  return (
    <RequirePermission entity="SupplierPayment" action="create">
      <PaySupplierBillScreen
        supplierId={supplierId}
        supplierGuuid={supplierGuuid}
        billId={billId}
        billGuuid={billGuuid}
        billNo={billNo}
        remainingPaise={remainingPaise}
      />
    </RequirePermission>
  );
}