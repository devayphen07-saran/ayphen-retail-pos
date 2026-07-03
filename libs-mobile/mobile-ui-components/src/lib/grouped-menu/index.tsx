import React from "react";
import styled from "styled-components/native";
import { View, ActivityIndicator, TouchableOpacity } from "react-native";
import { Typography } from "../typography";
import { LucideIcon, LucideIconNameType } from "../lucide-icon";
import { Flex } from "../layout/Flex";
import { Divider } from "../divider";
import { useMobileTheme } from "@ayphen/mobile-theme";

interface MenuItem {
  icon: LucideIconNameType | string;
  iconColor?: string;
  title: string;
  subtitle?: React.ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  showDivider?: boolean;
  rightIcon?: LucideIconNameType;
  rightIconColor?: string;
  onRightIconPress?: () => void;
}

interface MenuGroup {
  label: string;
  items: MenuItem[];
}

interface GroupedMenuProps {
  data: MenuGroup[];
  loading?: boolean;
  empty?: React.ReactNode;
  loader?: React.ReactNode;
  style?: object;
}

const Group: React.FC<{ children: React.ReactNode; style?: object }> = ({ children, style }) => (
  <GroupContainer style={style}>{children}</GroupContainer>
);

export const GroupedMenu: React.FC<GroupedMenuProps> = ({
  data,
  loading,
  empty,
  loader,
  style,
}) => {
  const { theme } = useMobileTheme();
  if (loading) return loader || <ActivityIndicator style={{ margin: 32 }} />;
  if (!data || data.length === 0) return empty || null;

  return (
    <View style={style}>
      {data.map((group, idx) => (
        <GroupWrapper key={`group-${idx}`}>
          <GroupLabel weight={"bold"}>{group.label}</GroupLabel>
          <Group>
            {group.items.map((item, j) => (
              <TouchableOpacity key={`item-${idx}-${j}`} onPress={item.onPress} activeOpacity={0.8}>
                <RowFlex>
                  <IconSlot>
                    <LucideIcon
                      name={item.icon as LucideIconNameType}
                      color={item.iconColor}
                      size={22}
                    />
                  </IconSlot>
                  <ContentFlex>
                    <Typography.Body weight="medium">{item.title}</Typography.Body>
                    {item.subtitle ? (
                      typeof item.subtitle === "string" ? (
                        <Typography.Caption type="secondary">
                          {item.subtitle}
                        </Typography.Caption>
                      ) : (
                        item.subtitle
                      )
                    ) : null}
                  </ContentFlex>
                  {item.rightIcon ? (
                    <TouchableOpacity
                      onPress={item.onRightIconPress}
                      disabled={!item.onRightIconPress}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <LucideIcon
                        name={item.rightIcon}
                        size={18}
                        color={item.rightIconColor || theme.colorTextTertiary}
                      />
                    </TouchableOpacity>
                  ) : (
                    item.chevron !== false && (
                      <LucideIcon name="ChevronRight" size={18} color={theme.colorTextTertiary} />
                    )
                  )}
                </RowFlex>
                {(item.showDivider ?? j < group.items.length - 1) && (
                  <Divider color={theme.colorBorder} thickness={0.3} marginVertical={0} />
                )}
              </TouchableOpacity>
            ))}
          </Group>
        </GroupWrapper>
      ))}
    </View>
  );
};

const GroupContainer = styled.View`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  padding: ${({ theme }) => theme.padding.xxSmall}px ${({ theme }) => theme.padding.large}px
    ${({ theme }) => theme.padding.xxSmall}px ${({ theme }) => theme.padding.small}px;
  margin-bottom: ${({ theme }) => theme.sizing.medium}px;
`;

const GroupWrapper = styled.View`
  margin-bottom: ${({ theme }) => theme.borderWidth.thin}px;
`;

const GroupLabel = styled(Typography.Subtitle)`
  margin-bottom: ${({ theme }) => theme.sizing.small}px;
`;

const RowFlex = styled(Flex)`
  flex-direction: row;
  align-items: center;
  padding-vertical: ${({ theme }) => theme.sizing.medium}px;
`;

const IconSlot = styled(Flex)`
  width: ${({ theme }) => theme.sizing.xLarge}px;
  align-items: center;
  justify-content: center;
  margin-right: ${({ theme }) => theme.sizing.small}px;
`;

const ContentFlex = styled(Flex)`
  flex: 1;
  margin-left: 0;
  gap: ${({ theme }) => theme.sizing.xxSmall}px;
`;