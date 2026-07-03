import React from "react";
import { TouchableOpacity } from "react-native";
import { useTheme } from "styled-components/native";
import { Typography } from "../typography";
import { LucideIcon, type LucideIconNameType } from "../lucide-icon";

interface Props {
  label: string;
  subtitle?: string;
  selected?: boolean;
  icon?: LucideIconNameType;
  badge?: string;
  destructive?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onPress: () => void;
}

/** Standard picker/action-menu row (§20). */
export function SheetListItem({
  label,
  subtitle,
  selected,
  icon,
  badge,
  destructive,
  disabled,
  disabledReason,
  onPress,
}: Props) {
  const theme = useTheme();
  const textColor = disabled
    ? theme.colorTextTertiary
    : destructive
      ? theme.colorError
      : theme.colorText;

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="menuitem"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      accessibilityLabel={disabled && disabledReason ? `${label}, ${disabledReason}` : label}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.sizing.small,
        paddingHorizontal: theme.sizing.medium,
        paddingVertical: theme.sizing.small,
      }}
    >
      {icon && <LucideIcon name={icon} size={18} color={textColor} />}
      <Typography.Body style={{ flex: 1, color: textColor }}>
        {label}
        {subtitle ? (
          <Typography.Caption color={theme.colorTextSecondary}>{`\n${subtitle}`}</Typography.Caption>
        ) : null}
      </Typography.Body>
      {badge && (
        <Typography.Caption color={theme.colorTextSecondary}>{badge}</Typography.Caption>
      )}
      {selected && <LucideIcon name="Check" size={18} color={theme.colorPrimary} />}
    </TouchableOpacity>
  );
}
