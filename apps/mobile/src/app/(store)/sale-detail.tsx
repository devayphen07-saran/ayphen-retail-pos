import { useLocalSearchParams } from 'expo-router';
import { SaleDetailScreen } from '@features/pos/screens/SaleDetailScreen';

export { RouteErrorBoundary as ErrorBoundary } from '@ui/RouteErrorBoundary';

type Params = { saleGuuid: string };

export default function SaleDetailRoute() {
  const { saleGuuid } = useLocalSearchParams<Params>();
  return <SaleDetailScreen saleGuuid={saleGuuid} />;
}