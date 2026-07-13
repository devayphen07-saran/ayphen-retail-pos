import { useLocalSearchParams } from 'expo-router';
import { RequirePermission } from '@core/auth/RequirePermission';
import { CreateCashMovementScreen } from '@features/ledger';

type Params = { accountId: string; accountGuuid: string; accountName: string };

export default function CashMovementCreateRoute() {
  const { accountId, accountGuuid, accountName } = useLocalSearchParams<Params>();
  return (
    <RequirePermission entity="CashMovement" action="create">
      <CreateCashMovementScreen accountId={accountId} accountGuuid={accountGuuid} accountName={accountName} />
    </RequirePermission>
  );
}