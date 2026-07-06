import { View } from 'react-native';
import { Column, Row, SkeletonBox } from '@ayphen/mobile-ui-components';
import { useMobileTheme } from '@ayphen/mobile-theme';

/** Layout-matched loading state for RolesListScreen — role cards (icon slot +
 *  name + description), so the real list swaps in without a jump (§2). */
export function RolesListLoading() {
  const { theme } = useMobileTheme();
  return (
    <Column gap={10}>
      {[0, 1, 2, 3].map((i) => (
        <View
          key={i}
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
              <SkeletonBox width={130} height={14} />
              <SkeletonBox width={180} height={11} />
            </Column>
            <SkeletonBox width={16} height={16} />
          </Row>
        </View>
      ))}
    </Column>
  );
}
