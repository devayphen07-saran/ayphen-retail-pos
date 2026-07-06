import { useLocalSearchParams } from 'expo-router';
import { StoreEntryScreen } from '@features/store/home/screens/StoreEntryScreen';

type Params = { storeId: string };

export default function HomeRoute() {
  const { storeId } = useLocalSearchParams<Params>();
  return <StoreEntryScreen storeId={storeId} />;
}