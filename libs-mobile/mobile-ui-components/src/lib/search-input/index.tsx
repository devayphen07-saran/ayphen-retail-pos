import React from "react";
import { TextInput, TextInputProps, TouchableOpacity, View } from "react-native";
import styled from "styled-components/native";
import { LucideIcon } from "../lucide-icon";
import { useMobileTheme, useBreakpoint } from "@nks/mobile-theme";

interface SearchInputProps extends Omit<TextInputProps, "onChange" | "value"> {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
}

export function SearchInput(props: SearchInputProps) {
  const { value, onChange, placeholder = "Search...", ...rest } = props;
  const { theme } = useMobileTheme();
  const { scale, fontScale } = useBreakpoint();
  const searchIconSize = Math.round(19 * scale);
  const clearIconSize = Math.round(18 * scale);

  return (
    <InputWrapper $scale={scale}>
      <StyledInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.color?.default?.borderActive}
        autoCapitalize="none"
        $fontScale={fontScale}
        {...rest}
      />

      {!value && (
        <SearchIcon>
          <LucideIcon name="Search" size={searchIconSize} color={theme.colorTextQuaternary} />
        </SearchIcon>
      )}

      {!!value && (
        <ClearButton onPress={() => onChange?.("")} hitSlop={10}>
          <LucideIcon name="X" size={clearIconSize} color={theme.colorTextQuaternary} />
        </ClearButton>
      )}
    </InputWrapper>
  );
}

/* ---------------- Styled Components ---------------- */

const InputWrapper = styled.View<{ $scale: number }>`
  flex-direction: row;
  align-items: center;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.regular}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  padding-left: ${({ $scale, theme }) => theme.sizing.xxSmall * $scale}px;
  padding-right: ${({ $scale, theme }) => theme.sizing.xSmall * $scale}px;
  height: ${({ $scale }) => 40 * $scale}px;
  flex-grow: 1;
`;

const StyledInput = styled(TextInput)<{ $fontScale: number }>`
  flex: 1;
  font-size: ${({ $fontScale, theme }) => theme.fontSize.small * $fontScale}px;
  color: ${({ theme }) => theme.colorText};
  background-color: ${({ theme }) => theme.transparent};
  padding-vertical: 0px;
  margin-left: ${({ theme }) => theme.sizing.xSmall}px;
`;

const ClearButton = styled(TouchableOpacity)`
  margin-left: ${({ theme }) => theme.sizing.xSmall}px;
`;

const SearchIcon = styled(View)`
  justify-content: center;
  align-items: center;
`;

export default SearchInput;
