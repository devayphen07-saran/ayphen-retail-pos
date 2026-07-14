import { useLocalSearchParams } from 'expo-router';
import { CustomerDetailScreen } from '@features/customers/screens/CustomerDetailScreen';

export { RouteErrorBoundary as ErrorBoundary } from '@ui/RouteErrorBoundary';

type Params = { customerGuuid: string };

export default function CustomerDetailRoute() {
  const { customerGuuid } = useLocalSearchParams<Params>();
  return <CustomerDetailScreen customerGuuid={customerGuuid} />;
}