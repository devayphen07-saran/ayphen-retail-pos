import React, { useState } from "react";
import styled from "styled-components/native";
import { useMobileTheme } from "@nks/mobile-theme";
import { LucideIcon, LucideIconNameType } from "../lucide-icon";
import { ActivityIndicator } from "react-native";

interface BorderConfig {
  showBorder?: boolean;
  color?: string;
  width?: number;
}

interface ImageWithoutPreviewProps {
  uri?: string;
  iconSize?: number;
  borderRadius?: number;
  fallbackIcon?: LucideIconNameType;
  fallbackBgColor?: string;
  fallbackIconColor?: string;
  border?: BorderConfig;
  loading?: boolean;
}

export const ImageWithoutPreview: React.FC<ImageWithoutPreviewProps> = ({
  uri,
  iconSize = 25,
  borderRadius = 0,
  fallbackIcon = "Package",
  fallbackBgColor,
  fallbackIconColor,
  border,
  loading,
}) => {
  const { theme } = useMobileTheme();
  const [imageLoading, setImageLoading] = useState(false);
  const [error, setError] = useState(false);

  const showFallback = !uri || error;

  return (
    <Wrapper
      $borderRadius={borderRadius}
      $fallbackBgColor={fallbackBgColor || theme.colorPrimary}
      $borderConfig={border}
    >
      {loading ? (
        <Centered>
          <ActivityIndicator color={theme.colorPrimary} />
        </Centered>
      ) : showFallback ? (
        <Centered>
          <LucideIcon
            name={fallbackIcon}
            color={fallbackIconColor || theme.colorWhite}
            size={iconSize}
          />
        </Centered>
      ) : (
        <>
          <StyledImage
            source={{ uri }}
            resizeMode="cover"
            $borderRadius={borderRadius}
            onLoadStart={() => setImageLoading(true)}
            onLoad={() => setImageLoading(false)}
            onError={() => {
              setError(true);
              setImageLoading(false);
            }}
          />
          {imageLoading && (
            <AbsoluteCenter>
              <ActivityIndicator color={theme.colorPrimary} />
            </AbsoluteCenter>
          )}
        </>
      )}
    </Wrapper>
  );
};
export default ImageWithoutPreview;

const Wrapper = styled.View<{
  $borderRadius: number;
  $fallbackBgColor: string;
  $borderConfig?: BorderConfig;
}>`
  width: 100%;
  height: 100%;
  border-radius: ${({ $borderRadius }) => $borderRadius}px;
  overflow: hidden;
  justify-content: center;
  align-items: center;
  background-color: ${({ $fallbackBgColor }) => $fallbackBgColor};
  border-width: ${({ $borderConfig }) =>
    $borderConfig?.showBorder ? ($borderConfig?.width ?? 1) : 0}px;
  border-color: ${({ $borderConfig, theme }) =>
    $borderConfig?.color ?? theme.transparent};
`;

const StyledImage = styled.Image<{ $borderRadius: number }>`
  width: 100%;
  height: 100%;
  border-radius: ${({ $borderRadius }) => $borderRadius}px;
`;

const Centered = styled.View`
  justify-content: center;
  align-items: center;
  flex: 1;
`;

const AbsoluteCenter = styled.View`
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  justify-content: center;
  align-items: center;
`;