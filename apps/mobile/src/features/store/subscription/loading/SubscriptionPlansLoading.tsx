import { View } from 'react-native';
import { Column, SkeletonBox } from '@ayphen/mobile-ui-components';
import { useMobileTheme } from '@ayphen/mobile-theme';

/** Layout-matched loading state: cycle toggle + plan cards, so the real cards
 *  swap in without a jump (loading-agent.md §2). */
export function SubscriptionPlansLoading() {
  const { theme } = useMobileTheme();
  return (
    <Column gap={20}>
      <SkeletonBox width="100%" height={44} borderRadius={theme.borderRadius.large} />
      <Column gap={12}>
        {[0, 1, 2].map((i) => (
          <View
            key={i}
            style={{
              borderWidth: theme.borderWidth.thin,
              borderColor: theme.colorBorder,
              backgroundColor: theme.colorBgContainer,
              borderRadius: theme.borderRadius.large,
              padding: theme.sizing.medium,
              gap: 8,
            }}
          >
            <SkeletonBox width={120} height={16} />
            <SkeletonBox width="80%" height={11} />
            <SkeletonBox width={140} height={26} />
            <Column gap={6} style={{ marginTop: 6 }}>
              <SkeletonBox width="70%" height={11} />
              <SkeletonBox width="62%" height={11} />
              <SkeletonBox width="66%" height={11} />
            </Column>
            <SkeletonBox
              width="100%"
              height={44}
              borderRadius={theme.borderRadius.medium}
              style={{ marginTop: 8 }}
            />
          </View>
        ))}
      </Column>
    </Column>
  );
}