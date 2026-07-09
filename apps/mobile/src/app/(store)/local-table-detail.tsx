import { Redirect } from 'expo-router';
import { LocalTableDetailScreen } from '@features/store/developer/screens/LocalTableDetailScreen';

// See local-tables.tsx — same-route __DEV__ guard, not just a hidden menu entry.
export default function LocalTableDetailRoute() {
  if (!__DEV__) return <Redirect href="/(store)" />;
  return <LocalTableDetailScreen />;
}
