import { useLocalSearchParams } from 'expo-router';
import { RequirePermission } from '@core/auth/RequirePermission';
import { CollectPaymentScreen } from '@features/customers/screens/CollectPaymentScreen';

type Params = { customerId: string; customerGuuid: string; customerName: string };

export default function CollectPaymentRoute() {
  const { customerId, customerGuuid, customerName } = useLocalSearchParams<Params>();
  return (
    <RequirePermission entity="Customer" action="create">
      <CollectPaymentScreen customerId={customerId} customerGuuid={customerGuuid} customerName={customerName} />
    </RequirePermission>
  );
}