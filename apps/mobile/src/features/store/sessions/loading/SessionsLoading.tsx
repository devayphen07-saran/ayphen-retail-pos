import { View } from 'react-native';
import { Column, Row, SkeletonBox } from '@ayphen/mobile-ui-components';
import { useMobileTheme } from '@ayphen/mobile-theme';

/** A single session-card skeleton, reused for both the "This Device" slot and
 *  each "Other Devices" row. */
export function SessionsLoadingCard() {
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
        </Column>
        <SkeletonBox width={72} height={28} borderRadius={theme.borderRadius.full} />
      </Row>
    </View>
  );
}

/** Layout-matched loading state for SessionsScreen — this-device + other-device
 *  cards, so the real list swaps in without a jump. */
export function SessionsLoading() {
  return (
    <Column gap={20}>
      <Column gap={10}>
        <SessionsLoadingCard />
      </Column>
      <Column gap={10}>
        <SessionsLoadingCard />
        <SessionsLoadingCard />
      </Column>
    </Column>
  );
}
