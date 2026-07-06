import { View } from 'react-native';
import { Column, Row, SkeletonBox } from '@ayphen/mobile-ui-components';
import { useMobileTheme } from '@ayphen/mobile-theme';

/** Layout-matched loading state: hero plan card + limits card + billing menu,
 *  so real content swaps in without a jump (loading-agent.md §2). */
export function SubscriptionLoading() {
  const { theme } = useMobileTheme();
  const card = {
    borderWidth: theme.borderWidth.thin,
    borderColor: theme.colorBorder,
    backgroundColor: theme.colorBgContainer,
    borderRadius: theme.borderRadius.large,
    overflow: 'hidden' as const,
  };
  return (
    <Column gap={20}>
      {/* Hero plan card */}
      <View
        style={{
          borderRadius: theme.borderRadius.xLarge,
          borderWidth: theme.borderWidth.thin,
          borderColor: theme.colorBorder,
          backgroundColor: theme.colorBgContainer,
          padding: theme.sizing.large,
          gap: 12,
        }}
      >
        <Row align="center" justify="space-between">
          <SkeletonBox width={100} height={12} />
          <SkeletonBox width={64} height={22} borderRadius={999} />
        </Row>
        <SkeletonBox width={170} height={26} />
        <SkeletonBox width="100%" height={6} borderRadius={3} />
        <SkeletonBox width={150} height={12} />
        <SkeletonBox width="100%" height={46} borderRadius={theme.borderRadius.large} />
      </View>

      {/* Plan limits */}
      <Column gap={10}>
        <SkeletonBox width={90} height={14} />
        <View style={card}>
          {[0, 1, 2, 3].map((i) => (
            <Row
              key={i}
              align="center"
              justify="space-between"
              style={{ paddingVertical: theme.sizing.small, paddingHorizontal: theme.sizing.medium }}
            >
              <Row align="center" gap={10}>
                <SkeletonBox width={30} height={30} borderRadius={theme.borderRadius.regular} />
                <SkeletonBox width={130} height={13} />
              </Row>
              <SkeletonBox width={40} height={13} />
            </Row>
          ))}
        </View>
      </Column>

      {/* Billing menu */}
      <View style={card}>
        {[0, 1].map((i) => (
          <Row key={i} align="center" gap={12} style={{ padding: theme.sizing.medium }}>
            <SkeletonBox width={36} height={36} borderRadius={theme.borderRadius.large} />
            <Column gap={6} flex={1}>
              <SkeletonBox width="50%" height={13} />
              <SkeletonBox width="70%" height={10} />
            </Column>
          </Row>
        ))}
      </View>
    </Column>
  );
}