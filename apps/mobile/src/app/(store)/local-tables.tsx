import { Redirect } from 'expo-router';
import { LocalTablesScreen } from '@features/store/developer/screens/LocalTablesScreen';

// __DEV__-gated at the route itself, not just the More-menu entry that links
// here (MoreScreen.tsx) — a hidden menu item alone doesn't stop a deep link
// or programmatic nav from reaching this SQLite table browser in a
// production build.
export default function LocalTablesRoute() {
  if (!__DEV__) return <Redirect href="/(store)" />;
  return <LocalTablesScreen />;
}