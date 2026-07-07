import { ScrollView } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { AppLayout, Column, Typography } from '@ayphen/mobile-ui-components';
import { MORE_SECTIONS, type MoreMenuItemConfig, ITEM_ROUTES, MenuRowList } from '@features/more';
import { useSyncIssueCount } from '@features/sync';

type Params = { sectionKey: string };

/**
 * Second level of the More menu — reached by tapping a section row on
 * MoreScreen (e.g. "Sales"). Lists that section's items (e.g. "Refunds &
 * Returns", "Promotions"); tapping an item goes to its real screen if one
 * exists yet, otherwise the generic "Coming soon" placeholder — same routing
 * MoreScreen used before the menu grew a section level.
 */
export function MoreSectionScreen() {
  const { theme } = useMobileTheme();
  const { sectionKey } = useLocalSearchParams<Params>();
  const section = MORE_SECTIONS.find((s) => s.key === sectionKey);
  const syncIssueCount = useSyncIssueCount();

  const openItem = (item: MoreMenuItemConfig) => {
    const route = ITEM_ROUTES[item.key];
    if (route) {
      router.push(route);
      return;
    }
    router.push({
      pathname: '/(store)/more-detail',
      params: { label: item.label, description: item.description },
    });
  };

  if (!section) {
    return (
      <AppLayout title="Not found" onBack={() => router.back()}>
        <Column flex={1} justify="center" align="center" padding="large">
          <Typography.Body>This menu section doesn&apos;t exist.</Typography.Body>
        </Column>
      </AppLayout>
    );
  }

  return (
    <AppLayout title={section.title} onBack={() => router.back()}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          padding: theme.sizing.medium,
          paddingBottom: 40,
        }}
      >
        <MenuRowList
          items={section.items.map((item) => ({
            key: item.key,
            title: item.label,
            description: item.description,
            iconName: item.iconName,
            iconColor: item.iconColor,
            onPress: () => openItem(item),
            badgeCount: item.key === 'sync-issues' ? syncIssueCount : undefined,
          }))}
        />
      </ScrollView>
    </AppLayout>
  );
}
