import { View } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Column,
  Divider,
  LucideIcon,
  Typography,
  type LucideIconNameType,
} from '@ayphen/mobile-ui-components';
import { resolveMenuColor } from '../utils/menu-utils';
import type { MenuColorToken } from '../utils/menu-config';

export interface MenuRowItem {
  key: string;
  title: string;
  description: string;
  iconName: LucideIconNameType;
  iconColor: MenuColorToken;
  onPress: () => void;
}

/**
 * One bordered card of pressable rows (icon + title + description + chevron),
 * shared by MoreScreen (one row per section) and MoreSectionScreen (one row
 * per item within a section) so the two levels of the More menu look
 * identical instead of each hand-rolling its own row styling.
 */
export function MenuRowList({ items }: { items: MenuRowItem[] }) {
  const { theme } = useMobileTheme();

  return (
    <GroupedCard>
      {items.map((item, i) => {
        const color = resolveMenuColor(theme, item.iconColor);
        const isLast = i === items.length - 1;
        return (
          <View key={item.key}>
            <RowPressable
              onPress={item.onPress}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel={item.title}
            >
              <IconContainer style={{ backgroundColor: `${color}15` }}>
                <LucideIcon name={item.iconName} size={20} color={color} />
              </IconContainer>
              <Column flex={1}>
                <Typography.Body
                  numberOfLines={1}
                  weight={600}
                  color={theme.colorText}
                  style={{ flexShrink: 1 }}
                >
                  {item.title}
                </Typography.Body>
                <Typography.Caption
                  numberOfLines={1}
                  color={theme.colorTextSecondary}
                  style={{ marginTop: 1 }}
                >
                  {item.description}
                </Typography.Caption>
              </Column>
              <LucideIcon name="ChevronRight" size={16} color={theme.colorTextTertiary} />
            </RowPressable>
            {!isLast && (
              <Divider thickness={1} color={theme.colorBorderSecondary} insetLeft={60} />
            )}
          </View>
        );
      })}
    </GroupedCard>
  );
}

const GroupedCard = styled(View)`
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  background-color: ${({ theme }) => theme.colorBgContainer};
  overflow: hidden;
`;

const RowPressable = styled.TouchableOpacity`
  flex-direction: row;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.small}px;
  padding: 14px ${({ theme }) => theme.sizing.medium}px;
`;

const IconContainer = styled(View)`
  width: 40px;
  height: 40px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  align-items: center;
  justify-content: center;
`;
