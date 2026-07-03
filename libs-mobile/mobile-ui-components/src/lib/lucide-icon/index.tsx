import React, { FC } from "react";
import * as icons from "lucide-react-native";
import { Pressable } from "react-native";
import { SvgProps } from "react-native-svg";
import { ColorType, useMobileTheme } from "@ayphen/mobile-theme";

type LucideIconComponent = FC<SvgProps & { size?: number }>;

export type LucideIconNameType = {
  [K in keyof typeof icons]: (typeof icons)[K] extends LucideIconComponent ? K : never;
}[keyof typeof icons];

export interface LucideIconProps {
  name: LucideIconNameType;
  size?: number;
  color?: string;
  colorType?: ColorType;
  onPress?: () => void;
  fill?: string;
  opacity?: number;
}

export const LucideIcon: FC<LucideIconProps> = ({
  name,
  size = 20,
  color,
  colorType = ColorType.default,
  onPress,
  fill = "none",
  opacity,
}) => {
  const { theme } = useMobileTheme();

  const Icon = icons[name] as LucideIconComponent;

  const resolvedColor = color ?? theme.color?.[colorType]?.main ?? theme.colorText;

  const icon = <Icon size={size} color={resolvedColor} fill={fill} opacity={opacity} />;

  if (onPress) {
    return (
      <Pressable onPress={onPress} hitSlop={6}>
        {icon}
      </Pressable>
    );
  }

  return icon;
};
