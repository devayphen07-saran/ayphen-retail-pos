import { View } from 'react-native';
import { Column, SkeletonBox } from '@ayphen/mobile-ui-components';
import { useMobileTheme } from '@ayphen/mobile-theme';

/** Layout-matched loading state for ProfileScreen — avatar + three rows, so
 *  the real content swaps in without a jump (same convention as
 *  MyDevicesLoading). */
export function ProfileLoading() {
  const { theme } = useMobileTheme();
  return (
    <Column gap={20} align="center">
      <SkeletonBox width={88} height={88} borderRadius={44} />
      <SkeletonBox width={160} height={18} />
      <Column gap={12} style={{ width: '100%', marginTop: theme.sizing.medium }}>
        {[0, 1].map((i) => (
          <View
            key={i}
            style={{
              padding: theme.sizing.medium,
              borderRadius: theme.borderRadius.large,
              borderWidth: theme.borderWidth.thin,
              borderColor: theme.colorBorder,
            }}
          >
            <SkeletonBox width={80} height={11} />
            <SkeletonBox width={180} height={16} style={{ marginTop: 8 }} />
          </View>
        ))}
      </Column>
    </Column>
  );
}
