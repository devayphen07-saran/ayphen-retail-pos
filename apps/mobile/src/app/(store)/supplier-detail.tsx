import { useLocalSearchParams } from 'expo-router';
import { SupplierDetailScreen } from '@features/suppliers/screens/SupplierDetailScreen';

export { RouteErrorBoundary as ErrorBoundary } from '@ui/RouteErrorBoundary';

type Params = { supplierGuuid: string };

export default function SupplierDetailRoute() {
  const { supplierGuuid } = useLocalSearchParams<Params>();
  return <SupplierDetailScreen supplierGuuid={supplierGuuid} />;
}
