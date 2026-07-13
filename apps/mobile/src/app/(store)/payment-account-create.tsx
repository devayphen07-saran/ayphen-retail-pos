import { RequirePermission } from '@core/auth/RequirePermission';
import { CreatePaymentAccountScreen } from '@features/payments/screens/CreatePaymentAccountScreen';

export default function PaymentAccountCreateRoute() {
  return (
    <RequirePermission entity="Payment" action="create">
      <CreatePaymentAccountScreen />
    </RequirePermission>
  );
}
