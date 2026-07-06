import React from "react";
import {
  Modal,
  TouchableWithoutFeedback,
  useWindowDimensions,
  ModalProps,
} from "react-native";
import styled, { css, useTheme } from "styled-components/native";

export interface BaseModalProps {
  visible: boolean;
  onClose: () => void;
  children?: React.ReactNode;
  animationType?: ModalProps["animationType"];
  transparent?: boolean;
  backdropColor?: string;
  position?: "center" | "bottom" | "top";
  disableBackdropPress?: boolean;
}

export const BaseModal: React.FC<BaseModalProps> = ({
  visible,
  onClose,
  children,
  animationType = "slide",
  transparent = true,
  backdropColor,
  position = "center",
  disableBackdropPress = false,
}) => {
  const { height, width } = useWindowDimensions();
  const theme = useTheme();
  // A param default can't reference theme, so resolve the token here.
  const resolvedBackdropColor = backdropColor ?? theme.overlay.scrim;

  const handleBackdropPress = () => {
    if (!disableBackdropPress && onClose) {
      onClose();
    }
  };

  return (
    <Modal
      animationType={animationType}
      transparent={transparent}
      visible={visible}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <TouchableWithoutFeedback onPress={handleBackdropPress}>
        <Backdrop $backdropColor={resolvedBackdropColor}>
          <TouchableWithoutFeedback>
            <ModalContainer $position={position} $width={width} $height={height}>{children}</ModalContainer>
          </TouchableWithoutFeedback>
        </Backdrop>
      </TouchableWithoutFeedback>
    </Modal>
  );
};

const Backdrop = styled.View<{ $backdropColor: string }>`
  flex: 1;
  justify-content: center;
  align-items: center;
  background-color: ${({ $backdropColor }) => $backdropColor};
`;

const ModalContainer = styled.View<{ $position: "center" | "bottom" | "top"; $width: number; $height: number }>`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.xLarge}px;
  padding: ${({ theme }) => theme.sizing.regular}px;
  width: ${({ $width }) => $width * 0.9}px;
  max-height: ${({ $height }) => $height * 0.8}px;

  ${({ $position, theme, $width }) =>
    $position === "bottom" &&
    css`
      position: absolute;
      bottom: 0px;
      width: ${$width}px;
      border-top-left-radius: ${theme.sizing.regular}px;
      border-top-right-radius: ${theme.sizing.regular}px;
      padding-bottom: ${theme.sizing.xLarge}px;
    `}

  ${({ $position, theme, $width }) =>
    $position === "top" &&
    css`
      position: absolute;
      top: 0px;
      width: ${$width}px;
      border-bottom-left-radius: ${theme.sizing.regular}px;
      border-bottom-right-radius: ${theme.sizing.regular}px;
    `}

  ${({ $position }) =>
    $position === "center" &&
    css`
      justify-content: center;
    `}
`;
