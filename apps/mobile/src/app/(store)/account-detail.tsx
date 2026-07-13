import { useLocalSearchParams } from 'expo-router';
import { AccountDetailScreen } from '@features/ledger';

export { RouteErrorBoundary as ErrorBoundary } from '@ui/RouteErrorBoundary';

type Params = { accountGuuid: string };

export default function AccountDetailRoute() {
  const { accountGuuid } = useLocalSearchParams<Params>();
  return <AccountDetailScreen accountGuuid={accountGuuid} />;
}