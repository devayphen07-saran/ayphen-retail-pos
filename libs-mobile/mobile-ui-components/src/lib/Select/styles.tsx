import styled from "styled-components/native";
import { Animated, Platform, TouchableOpacity, View } from "react-native";
import type { DefaultTheme } from "styled-components/native";

interface InputStylesArgs {
  $hasError?: boolean;
  theme: DefaultTheme;
  $scale?: number;
}

export const inputStylesCss = ({ $hasError, theme, $scale = 1 }: InputStylesArgs) => ({
  borderWidth: theme.borderWidth?.borderWidthThin ?? 1,
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

export const SelectBackdrop = styled.Pressable`
  flex: 1;
  background-color: rgba(0, 0, 0, 0.18);
`;

export const SelectAnimatedSheetContainer = styled(Animated.View)`
  background-color: ${({ theme }) => theme.colorBgLayout};
  border-top-left-radius: ${({ theme }) => theme.borderRadius.xxLarge + theme.borderRadius.xSmall}px;
  border-top-right-radius: ${({ theme }) => theme.borderRadius.xxLarge + theme.borderRadius.xSmall}px;
  padding-top: ${({ theme }) => theme.sizing.small}px;
  min-height: 260px;
  max-height: 80%;
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
`;

export const SelectSheetBar = styled(View)`
  align-self: center;
  width: 44px;
  height: ${({ theme }) => theme.borderRadius.medium}px;
  border-radius: ${({ theme }) => theme.borderRadius.xSmall}px;
  background-color: ${({ theme }) => theme.colorBorder};
  margin-bottom: ${({ theme }) => theme.sizing.xSmall}px;
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
    (Platform.OS === 'ios' ? theme.padding?.small ?? 8 : 10) * $scale}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-width: ${({ theme }) => theme.borderWidth?.borderWidthThin ?? 1}px;
  border-color: ${({ $hasError, theme }) =>
    $hasError ? theme.colorError : theme.colorBorder};
  border-radius: ${({ theme, $scale = 1 }) =>
    (theme.borderRadius?.medium ?? 8) * $scale}px;
`;
