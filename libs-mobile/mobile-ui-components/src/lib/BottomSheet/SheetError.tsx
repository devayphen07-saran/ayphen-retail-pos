import React from "react";
import { View } from "react-native";
import { useTheme } from "styled-components/native";
import { Typography } from "../typography";
import { Button } from "../button";
import { LucideIcon } from "../lucide-icon";

interface Props {
  message: string;
  onRetry?: () => void;
}

/** Standard error state for sheet content — message + optional retry. */
export function SheetError({ message, onRetry }: Props) {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        padding: theme.sizing.large,
        gap: theme.sizing.small,
      }}
    >
      <LucideIcon name="CircleAlert" size={28} color={theme.colorTextTertiary} />
      <Typography.Body color={theme.colorTextSecondary} style={{ textAlign: "center" }}>
        {message}
      </Typography.Body>
      {onRetry && <Button label="Retry" variant="text" onPress={onRetry} size="sm" />}
    </View>
  );
}
