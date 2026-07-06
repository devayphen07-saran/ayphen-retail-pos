import styled from "styled-components/native";
import { Platform, TouchableOpacity, View } from "react-native";
import type { DefaultTheme } from "styled-components/native";

interface InputStylesArgs {
  $hasError?: boolean;
  theme: DefaultTheme;
  $scale?: number;
}

export const inputStylesCss = ({ $hasError, theme, $scale = 1 }: InputStylesArgs) => ({
  borderWidth: theme.borderWidth?.thin ?? 1,
  borderColor: $hasError ? theme.colorError : theme.colorBorder,
  borderRadius: (theme.borderRadius?.medium ?? 8) * $scale,
  padding: (theme.padding?.small ?? 8) * $scale,
  fontSize: theme.fontSize?.medium ?? 14,
  fontFamily: theme.fontFamily?.poppinsRegular,
  color: theme.colorText,
});

interface SelectTouchableProps extends React.ComponentProps<typeof TouchableOpacity> {
  $hasError?: boolean;
  $scale?: number;
}

export const SelectGenericContainer = styled.View`
  padding-bottom: ${({ theme }) => theme.sizing.small}px;
`;

export const Separator = styled(View)`
  height: ${({ theme }) => theme.borderWidth.thin}px;
  background-color: ${({ theme }) => theme.colorBorder};
  margin-left: ${({ theme }) => theme.margin.xSmall}px;
  margin-right: ${({ theme }) => theme.margin.xSmall}px;
`;

export const SelectLabelText = styled.Text<{ $fontScale?: number }>`
  font-size: ${({ theme, $fontScale = 1 }) => (theme.fontSize?.small ?? 12) * $fontScale}px;
  font-family: ${({ theme }) => theme.fontFamily?.poppinsRegular};
  color: ${({ theme }) => theme.colorText};
`;

export const SelectTouchable = styled(TouchableOpacity)<SelectTouchableProps>`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: ${({ theme, $scale = 1 }) =>
    (Platform.OS === 'ios' ? theme.padding?.small ?? 8 : theme.sizing.small) * $scale}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-width: ${({ theme }) => theme.borderWidth?.thin ?? 1}px;
  border-color: ${({ $hasError, theme }) =>
    $hasError ? theme.colorError : theme.colorBorder};
  border-radius: ${({ theme, $scale = 1 }) =>
    (theme.borderRadius?.medium ?? 8) * $scale}px;
`;
