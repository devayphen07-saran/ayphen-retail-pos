import { memo } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, LucideIcon, Row, Tag, Typography } from '@ayphen/mobile-ui-components';
import type { RoleResponse } from '@ayphen/api-manager';

export const RoleCard = memo(function RoleCard({ role }: { role: RoleResponse }) {
  const { theme } = useMobileTheme();
  return (
    <CardContainer
      activeOpacity={0.7}
      onPress={() =>
        router.push({ pathname: '/(store)/role-permissions', params: { roleId: role.id } })
      }
    >
      <Row align="center" gap={12}>
        <IconSlot>
          <LucideIcon name="ShieldCheck" size={20} color={theme.colorPrimary} />
        </IconSlot>
        <Column flex={1} gap={4}>
          <Typography.Body weight="medium">{role.name}</Typography.Body>
          <Row gap={6} align="center">
            {role.description && (
              <Typography.Caption type="secondary">{role.description}</Typography.Caption>
            )}
            {!role.is_editable && <Tag label="System" variant="default" size="sm" />}
          </Row>
        </Column>
        <LucideIcon name="ChevronRight" size={16} color={theme.colorTextTertiary} />
      </Row>
    </CardContainer>
  );
});

const CardContainer = styled.TouchableOpacity`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  padding: ${({ theme }) => theme.sizing.medium}px;
`;

const IconSlot = styled(View)`
  width: 40px;
  height: 40px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme }) => theme.color.primary.bg};
`;
