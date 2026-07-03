import React from "react";
import { Pressable, StyleProp, ViewStyle } from "react-native";
import styled from "styled-components/native";
import { useMobileTheme } from "@ayphen/mobile-theme";

import { LucideIcon } from "../lucide-icon";
import { Typography } from "../typography";
import { formatRelativeTime } from "./relative-time";

export interface ConflictSide {
  label: string;
  value: string;
  /** ms when this side was last changed, used to render "(2m ago)". Optional. */
  changedAtMs?: number | null;
}

export interface ConflictRowProps {
  entityLabel: string;
  fieldLabel?: string;
  local: ConflictSide;
  server: ConflictSide;
  onKeepLocal?: () => void;
  onKeepServer?: () => void;
  onInspect?: () => void;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}

export const ConflictRow: React.FC<ConflictRowProps> = ({
  entityLabel,
  fieldLabel,
  local,
  server,
  onKeepLocal,
  onKeepServer,
  onInspect,
  busy = false,
  style,
}) => {
  const { theme } = useMobileTheme();

  return (
    <Card style={style} accessibilityRole="summary">
      <HeaderRow>
        <LucideIcon
          name="GitMerge"
          size={16}
          color={theme.color.warning.text}
        />
        <HeaderText numberOfLines={1}>
          {entityLabel}
          {fieldLabel ? ` · ${fieldLabel}` : ""}
        </HeaderText>
      </HeaderRow>

      <SideBlock>
        <SideHeader>
          <SideLabel>{local.label}</SideLabel>
          {local.changedAtMs ? (
            <SideMeta>{formatRelativeTime(local.changedAtMs)}</SideMeta>
          ) : null}
        </SideHeader>
        <SideValue numberOfLines={2}>{local.value}</SideValue>
        {onKeepLocal ? (
          <Action
            onPress={onKeepLocal}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`Keep ${local.label}`}
            $tone="primary"
          >
            <ActionLabel $tone="primary">Keep mine</ActionLabel>
          </Action>
        ) : null}
      </SideBlock>

      <Divider />

      <SideBlock>
        <SideHeader>
          <SideLabel>{server.label}</SideLabel>
          {server.changedAtMs ? (
            <SideMeta>{formatRelativeTime(server.changedAtMs)}</SideMeta>
          ) : null}
        </SideHeader>
        <SideValue numberOfLines={2}>{server.value}</SideValue>
        {onKeepServer ? (
          <Action
            onPress={onKeepServer}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`Keep ${server.label}`}
            $tone="grey"
          >
            <ActionLabel $tone="grey">Use server</ActionLabel>
          </Action>
        ) : null}
      </SideBlock>

      {onInspect ? (
        <InspectRow
          onPress={onInspect}
          accessibilityRole="button"
          accessibilityLabel="Inspect conflict"
        >
          <InspectText>Inspect</InspectText>
          <LucideIcon name="ChevronRight" size={14} colorType="grey" />
        </InspectRow>
      ) : null}
    </Card>
  );
};

const Card = styled.View`
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.color.warning.border};
  background-color: ${({ theme }) => theme.colorBgContainer};
  padding: ${({ theme }) => theme.sizing.small}px;
  gap: ${({ theme }) => theme.sizing.xSmall}px;
`;

const HeaderRow = styled.View`
  flex-direction: row;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.xSmall}px;
`;

const HeaderText = styled(Typography.Subtitle)`
  flex: 1;
  color: ${({ theme }) => theme.colorText};
`;

const SideBlock = styled.View`
  gap: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const SideHeader = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
`;

const SideLabel = styled(Typography.Caption)`
  font-family: ${({ theme }) => theme.fontFamily.poppinsMedium};
  color: ${({ theme }) => theme.colorTextSecondary};
`;

const SideMeta = styled(Typography.Caption)`
  color: ${({ theme }) => theme.colorTextTertiary};
`;

const SideValue = styled(Typography.Body)`
  color: ${({ theme }) => theme.colorText};
`;

const Divider = styled.View`
  height: ${({ theme }) => theme.borderWidth.thin}px;
  background-color: ${({ theme }) => theme.colorBorder};
`;

const Action = styled(Pressable)<{ disabled?: boolean; $tone: "primary" | "grey" }>`
  align-self: flex-start;
  padding-vertical: ${({ theme }) => theme.sizing.xxSmall}px;
  padding-horizontal: ${({ theme }) => theme.sizing.xSmall}px;
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
  background-color: ${({ theme, $tone }) =>
    $tone === "primary" ? theme.color.primary.main : theme.color.grey.bgActive};
  opacity: ${({ disabled }) => (disabled ? 0.5 : 1)};
  margin-top: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const ActionLabel = styled(Typography.Caption)<{ $tone: "primary" | "grey" }>`
  color: ${({ theme, $tone }) =>
    $tone === "primary" ? theme.color.primary.onMain : theme.color.grey.text};
  font-family: ${({ theme }) => theme.fontFamily.poppinsMedium};
`;

const InspectRow = styled(Pressable)`
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
  gap: ${({ theme }) => theme.sizing.xxSmall}px;
  padding-top: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const InspectText = styled(Typography.Caption)`
  color: ${({ theme }) => theme.colorTextSecondary};
`;

export default ConflictRow;
