import { View } from 'react-native';
import { Column, Row, SkeletonBox } from '@ayphen/mobile-ui-components';
import { useMobileTheme } from '@ayphen/mobile-theme';

/** Layout-matched loading state: header + cycle toggle + plan cards + compare
 *  table, so the real content swaps in without a jump (loading-agent.md §2). */
export function SubscriptionPlansLoading() {
  const { theme } = useMobileTheme();
  return (
    <Column gap={20}>
      <Column gap={8}>
        <SkeletonBox width="70%" height={22} />
        <SkeletonBox width="55%" height={13} />
      </Column>

      <SkeletonBox width="100%" height={48} borderRadius={theme.borderRadius.large} />

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
            <Row align="center" justify="space-between">
              <SkeletonBox width={90} height={16} />
              <SkeletonBox width={70} height={20} />
            </Row>
            <SkeletonBox width="80%" height={11} />
            <Row wrap="wrap" gap={8} style={{ marginTop: 6 }}>
              <SkeletonBox width="47%" height={11} />
              <SkeletonBox width="47%" height={11} />
              <SkeletonBox width="47%" height={11} />
              <SkeletonBox width="47%" height={11} />
            </Row>
            <SkeletonBox
              width="100%"
              height={44}
              borderRadius={theme.borderRadius.medium}
              style={{ marginTop: 8 }}
            />
          </View>
        ))}
      </Column>

      <Column gap={10}>
        <SkeletonBox width={110} height={16} />
        <SkeletonBox width="100%" height={140} borderRadius={theme.borderRadius.large} />
      </Column>
    </Column>
  );
}