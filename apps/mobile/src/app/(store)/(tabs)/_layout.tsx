import { Tabs } from 'expo-router';
import { CustomTabBar } from '@ui/CustomTabBar';

/** Store tab shell — Home / POS / Customer / More. */
export default function StoreTabsLayout() {
  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <CustomTabBar {...props} />}
    >
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="pos" options={{ title: 'POS' }} />
      <Tabs.Screen name="products" options={{ title: 'Products' }} />
      <Tabs.Screen name="customer" options={{ title: 'Customer' }} />
      <Tabs.Screen name="more" options={{ title: 'More' }} />
    </Tabs>
  );
}
