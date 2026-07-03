import React from "react";
import { View } from "react-native";
import { useTheme } from "styled-components/native";
import { Button } from "../button";

interface Props {
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  destructive?: boolean;
}

/** Standard confirm/cancel pair for confirmation sheets (§20). */
export function SheetConfirmActions({
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  loading,
  destructive,
}: Props) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        gap: theme.sizing.small,
        paddingHorizontal: theme.sizing.medium,
        paddingTop: theme.sizing.small,
      }}
    >
      <Button
        label={cancelLabel}
        variant="default"
        onPress={onCancel}
        disabled={loading}
        style={{ flex: 1 }}
      />
      <Button
        label={confirmLabel}
        variant={destructive ? "default" : "primary"}
        borderColor={destructive ? theme.colorError : undefined}
        textColor={destructive ? theme.colorError : undefined}
        onPress={onConfirm}
        loading={loading}
        style={{ flex: 1 }}
      />
    </View>
  );
}
