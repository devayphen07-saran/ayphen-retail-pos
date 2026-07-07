import { View } from 'react-native';
import { Column, Row, SkeletonBox } from '@ayphen/mobile-ui-components';
import { useMobileTheme } from '@ayphen/mobile-theme';

/** A single device-card skeleton — used per-slot by ListScaffold's loader and
 *  by the full-list MyDevicesLoading below (§2). */
export function MyDevicesLoadingCard() {
  const { theme } = useMobileTheme();
  return (
    <View
      style={{
        padding: theme.sizing.medium,
        borderRadius: theme.borderRadius.large,
        borderWidth: theme.borderWidth.thin,
        borderColor: theme.colorBorder,
      }}
    >
      <Row align="center" gap={12}>
        <SkeletonBox width={40} height={40} borderRadius={theme.borderRadius.large} />
        <Column flex={1} gap={8}>
          <SkeletonBox width={140} height={14} />
          <SkeletonBox width={200} height={11} />
          <Row gap={6}>
            <SkeletonBox width={72} height={16} borderRadius={999} />
            <SkeletonBox width={56} height={16} borderRadius={999} />
          </Row>
        </Column>
        <SkeletonBox width={16} height={16} />
      </Row>
    </View>
  );
}

/** Layout-matched loading state for MyDevicesScreen — device cards, so the real
 *  list swaps in without a jump (§2). */
export function MyDevicesLoading() {
  return (
    <Column gap={10}>
      {[0, 1, 2].map((i) => (
        <MyDevicesLoadingCard key={i} />
      ))}
    </Column>
  );
}