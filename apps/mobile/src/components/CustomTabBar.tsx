import { Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Row, Column, LucideIcon, Typography, type LucideIconNameType } from '@ayphen/mobile-ui-components';

const TAB_ICON: Record<string, LucideIconNameType> = {
  index: 'Home',
  pos: 'ShoppingCart',
  products: 'Package',
  customer: 'Users',
  more: 'MoreHorizontal',
};

/** Custom bottom tab bar for the (store) stack — Home / POS / Customer / More. */
export function CustomTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { theme } = useMobileTheme();
  const insets = useSafeAreaInsets();

  return (
    <Row
      justify="space-around"
      align="center"
      bg={theme.colorBgContainer}
      style={{
        borderTopWidth: 1,
        borderTopColor: theme.colorBorder,
        paddingTop: theme.sizing.xSmall,
        paddingBottom: insets.bottom || theme.sizing.xSmall,
      }}
    >
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const label = options.title ?? route.name;
        const isFocused = state.index === index;
        const color = isFocused ? theme.colorPrimary : theme.colorTextSecondary;

        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });

          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };

        return (
          <Pressable
            key={route.key}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : {}}
            accessibilityLabel={label}
            style={{ flex: 1, alignItems: 'center' }}
          >
            <Column align="center" gap={2}>
              <LucideIcon name={TAB_ICON[route.name] ?? 'Circle'} size={22} color={color} />
              <Typography.Overline color={color}>{label}</Typography.Overline>
            </Column>
          </Pressable>
        );
      })}
    </Row>
  );
}