import React from "react";
import { TextInput, View } from "react-native";
import { useTheme } from "styled-components/native";
import { LucideIcon } from "../lucide-icon";

interface Props {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
}

/** Auto-focus search input for search-picker sheet content (§19). */
export function SheetSearchBar({ value, onChangeText, placeholder = "Search…" }: Props) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.sizing.xSmall,
        marginHorizontal: theme.sizing.medium,
        marginBottom: theme.sizing.small,
        paddingHorizontal: theme.sizing.small,
        borderRadius: theme.borderRadius.large,
        backgroundColor: theme.colorBgLayout,
      }}
    >
      <LucideIcon name="Search" size={16} color={theme.colorTextSecondary} />
      <TextInput
        style={{ flex: 1, color: theme.colorText, paddingVertical: theme.sizing.xSmall }}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colorTextSecondary}
        returnKeyType="search"
        autoFocus
        autoCorrect={false}
        autoCapitalize="none"
        accessibilityLabel={placeholder}
      />
      {value.length > 0 && (
        <LucideIcon
          name="XCircle"
          size={16}
          color={theme.colorTextSecondary}
          onPress={() => onChangeText("")}
        />
      )}
    </View>
  );
}
