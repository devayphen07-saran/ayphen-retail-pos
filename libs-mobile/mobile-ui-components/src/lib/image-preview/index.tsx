import React, { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  TouchableOpacity,
  TouchableWithoutFeedback,
} from 'react-native';
import styled from 'styled-components/native';
import { Image as ExpoImage } from 'expo-image';
import { X } from 'lucide-react-native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { InitialsTile } from '../initials-tile';
import { LucideIcon, LucideIconNameType } from '../lucide-icon';

interface BorderConfig {
  showBorder?: boolean;
  color?: string;
  width?: number;
}

interface ImagePreviewProps {
  uri?: string;
  /**
   * Drives the placeholder when `uri` is missing or fails to load. If set,
   * the initials of this text are shown on a deterministic colored tile.
   * Preferred for entity-bound images (product, customer, store, user).
   */
  fallbackText?: string;
  /**
   * Opt-in icon placeholder. Only used when `fallbackText` is NOT set. For
   * genuinely entity-less placeholders (empty gallery, category picker, etc.).
   * Do not use this as a generic "broken image" indicator — pick a meaningful
   * icon or omit and let the "?" tile render instead.
   */
  fallbackIcon?: LucideIconNameType;
  size?: number;
  iconSize?: number;
  borderRadius?: number;
  previewEnabled?: boolean;
  border?: BorderConfig;
  loading?: boolean;
  fallbackBgColor?: string;
  fallbackTextColor?: string;
  fallbackIconColor?: string;
}

export const ImagePreview: React.FC<ImagePreviewProps> = ({
  uri,
  fallbackText,
  fallbackIcon,
  size = 70,
  iconSize,
  borderRadius = 0,
  previewEnabled = true,
  border,
  loading,
  fallbackBgColor,
  fallbackTextColor,
  fallbackIconColor,
}) => {
  const { theme } = useMobileTheme();
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);

  const handlePress = () => {
    if (previewEnabled && uri && !error) setOpen(true);
  };

  const showFallback = !uri || error;
  const useIconFallback = !fallbackText && !!fallbackIcon;

  return (
    <>
      <TouchableOpacity activeOpacity={0.9} onPress={handlePress}>
        <Wrapper
          $size={size}
          $borderRadius={borderRadius}
          $borderConfig={border}
        >
          {loading ? (
            <LoadingTile $size={size} $borderRadius={borderRadius}>
              <ActivityIndicator color={theme.color.grey.main} />
            </LoadingTile>
          ) : showFallback ? (
            useIconFallback ? (
              <IconFallback
                $size={size}
                $borderRadius={borderRadius}
                $bg={fallbackBgColor ?? theme.colorBgLayout}
              >
                <LucideIcon
                  name={fallbackIcon!}
                  color={fallbackIconColor ?? theme.color.grey.main}
                  size={iconSize ?? Math.round(size * 0.4)}
                />
              </IconFallback>
            ) : (
              <InitialsTile
                text={fallbackText}
                size={size}
                borderRadius={borderRadius}
                bgColor={fallbackBgColor}
                textColor={fallbackTextColor}
              />
            )
          ) : (
            <StyledImage
              source={{ uri }}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={150}
              $size={size}
              $borderRadius={borderRadius}
              onError={() => setError(true)}
            />
          )}
        </Wrapper>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade">
        <TouchableWithoutFeedback onPress={() => setOpen(false)}>
          <ModalContainer>
            <CloseButton onPress={() => setOpen(false)}>
              <X color={theme.colorWhite} size={28} />
            </CloseButton>

            <PreviewImage
              source={{ uri }}
              contentFit="contain"
              cachePolicy="memory-disk"
              transition={150}
              onError={() => setError(true)}
            />
          </ModalContainer>
        </TouchableWithoutFeedback>
      </Modal>
    </>
  );
};

const Wrapper = styled.View<{
  $size: number;
  $borderRadius: number;
  $borderConfig?: BorderConfig;
}>`
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  border-radius: ${({ $borderRadius }) => $borderRadius}px;
  overflow: hidden;
  justify-content: center;
  align-items: center;
  border-width: ${({ $borderConfig }) =>
    $borderConfig?.showBorder ? ($borderConfig?.width ?? 1) : 0}px;
  border-color: ${({ $borderConfig, theme }) =>
    $borderConfig?.color ?? theme.transparent};
`;

const StyledImage = styled(ExpoImage)<{ $size: number; $borderRadius: number }>`
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  border-radius: ${({ $borderRadius }) => $borderRadius}px;
`;

const LoadingTile = styled.View<{ $size: number; $borderRadius: number }>`
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  border-radius: ${({ $borderRadius }) => $borderRadius}px;
  justify-content: center;
  align-items: center;
`;

const IconFallback = styled.View<{
  $size: number;
  $borderRadius: number;
  $bg: string;
}>`
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  border-radius: ${({ $borderRadius }) => $borderRadius}px;
  background-color: ${({ $bg }) => $bg};
  justify-content: center;
  align-items: center;
`;

const ModalContainer = styled.View`
  flex: 1;
  background-color: rgba(0, 0, 0, 0.9);
  justify-content: center;
  align-items: center;
`;

const CloseButton = styled.TouchableOpacity`
  position: absolute;
  top: ${({ theme }) => theme.sizing.xxLarge}px;
  right: ${({ theme }) => theme.sizing.xSmall}px;
  z-index: 2;
`;

const PreviewImage = styled(ExpoImage)`
  width: 90%;
  height: 80%;
`;