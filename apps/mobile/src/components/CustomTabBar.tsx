import { Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import styled from 'styled-components/native';
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
    <TabBarRow
      justify="space-around"
      align="center"
      bg={theme.colorBgContainer}
      $bottomInset={insets.bottom}
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
            // The real hit area was just the icon+label cluster (well under
            // the 44pt minimum) — this is the single most-tapped control in
            // the app, so stretch the pressable to the full bar height.
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 44 }}
          >
            <Column align="center" gap={2}>
              <LucideIcon name={TAB_ICON[route.name] ?? 'Circle'} size={22} color={color} />
              <Typography.Overline color={color}>{label}</Typography.Overline>
            </Column>
          </Pressable>
        );
      })}
    </TabBarRow>
  );
}

// `insets.bottom` is a runtime device value (not a design token), so it's
// passed through as a transient prop rather than baked into the CSS.
const TabBarRow = styled(Row)<{ $bottomInset: number }>`
  border-top-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-top-color: ${({ theme }) => theme.colorBorder};
  padding-top: ${({ theme }) => theme.sizing.xSmall}px;
  padding-bottom: ${({ theme, $bottomInset }) => $bottomInset || theme.sizing.xSmall}px;
`;