import React, { useEffect, useState } from "react";
import { StyleProp, ViewStyle } from "react-native";
import styled from "styled-components/native";

import { LucideIcon } from "../lucide-icon";
import { Typography } from "../typography";
import { formatRelativeTime } from "./relative-time";

export interface LastSyncedAtProps {
  /** Epoch ms of the most recent successful sync. `null` = never synced. */
  timestampMs: number | null;
  /** How often (ms) to refresh the relative label. Defaults to 30s. */
  refreshIntervalMs?: number;
  prefix?: string;
  style?: StyleProp<ViewStyle>;
}

export const LastSyncedAt: React.FC<LastSyncedAtProps> = ({
  timestampMs,
  refreshIntervalMs = 30_000,
  prefix = "Last synced",
  style,
}) => {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (timestampMs == null) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), refreshIntervalMs);
    return () => clearInterval(id);
  }, [timestampMs, refreshIntervalMs]);

  const relative = formatRelativeTime(timestampMs);

  return (
    <Container style={style} accessibilityRole="text">
      <LucideIcon name="Clock" size={12} colorType="grey" />
      <Label>
        {prefix} {relative}
      </Label>
    </Container>
  );
};

const Container = styled.View`
  flex-direction: row;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const Label = styled(Typography.Caption)`
  color: ${({ theme }) => theme.colorTextSecondary};
`;

export default LastSyncedAt;