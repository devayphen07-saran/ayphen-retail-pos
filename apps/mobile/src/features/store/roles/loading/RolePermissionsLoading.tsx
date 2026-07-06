import { View } from 'react-native';
import { Column, Row, SkeletonBox } from '@ayphen/mobile-ui-components';
import { useMobileTheme } from '@ayphen/mobile-theme';

/** Layout-matched loading state: entity cards each with a header row + a row of
 *  action checkboxes, so the real matrix swaps in without a jump (§2). */
export function RolePermissionsLoading() {
  const { theme } = useMobileTheme();
  return (
    <Column gap={8}>
      {[0, 1, 2, 3, 4].map((i) => (
        <View
          key={i}
          style={{
            gap: theme.sizing.small,
            padding: theme.sizing.medium,
            borderRadius: theme.borderRadius.large,
            borderWidth: theme.borderWidth.thin,
            borderColor: theme.colorBorder,
          }}
        >
          <Row align="center" justify="space-between">
            <SkeletonBox width={120} height={14} />
            <SkeletonBox width={90} height={16} />
          </Row>
          <Row gap={16}>
            {[0, 1, 2, 3].map((j) => (
              <SkeletonBox key={j} width={56} height={16} />
            ))}
          </Row>
        </View>
      ))}
    </Column>
  );
}
