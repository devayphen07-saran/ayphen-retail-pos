import { useLocalSearchParams } from 'expo-router';
import { RequirePermission } from '@core/auth/RequirePermission';
import { RefundScreen } from '@features/pos/screens/RefundScreen';

type Params = { saleId: string; saleGuuid: string };

export default function RefundCreateRoute() {
  const { saleId, saleGuuid } = useLocalSearchParams<Params>();
  return (
    <RequirePermission entity="Refund" action="create">
      <RefundScreen saleId={saleId} saleGuuid={saleGuuid} />
    </RequirePermission>
  );
}