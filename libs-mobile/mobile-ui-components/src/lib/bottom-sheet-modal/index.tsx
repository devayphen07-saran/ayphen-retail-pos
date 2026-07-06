import React, { ReactNode } from "react";
import { Modal, StyleSheet, TouchableOpacity, View } from "react-native";
import styled from "styled-components/native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Typography } from "../typography";

export interface BottomSheetModalProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  headerLeft?: ReactNode;
  headerRight?: ReactNode;
  children: ReactNode;
  height?: number;
}

export const BottomSheetModal: React.FC<BottomSheetModalProps> = ({
  visible,
  onClose,
  title,
  headerLeft,
  headerRight,
  children,
  height = 400,
}) => {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Backdrop activeOpacity={1} onPress={onClose}>
        {/* TouchableOpacity backdrop swallows taps — inner View stops propagation */}
        <Sheet style={{ height }}>
          <Clip>
            {/* Handle */}
            <HandleZone>
              <HandleBar />
            </HandleZone>

            {/* Header */}
            {(title != null || headerLeft != null || headerRight != null) && (
              <HeaderRow>
                <HeaderSide>{headerLeft ?? null}</HeaderSide>
                <HeaderCenter>
                  {title != null && (
                    <Typography.H5 numberOfLines={1}>{title}</Typography.H5>
                  )}
                </HeaderCenter>
                <HeaderSide style={styles.headerSideEnd}>
                  {headerRight ?? null}
                </HeaderSide>
              </HeaderRow>
            )}

            {/* Content */}
            <SafeAreaView edges={["bottom"]} style={styles.flex}>
              {children}
            </SafeAreaView>
          </Clip>
        </Sheet>
      </Backdrop>
    </Modal>
  );
};

export default BottomSheetModal;

// ─── Styles ─────────────────────────────────────────────────────────────────

const Backdrop = styled(TouchableOpacity)`
  flex: 1;
  background-color: ${({ theme }) => theme.overlay.scrimSoft};
  justify-content: flex-end;
`;

/** Outer shell carries the shadow — no overflow:hidden so shadow escapes. */
const Sheet = styled(View)`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-top-left-radius: ${({ theme }) =>
    theme.borderRadius.xxLarge + theme.borderRadius.large}px;
  border-top-right-radius: ${({ theme }) =>
    theme.borderRadius.xxLarge + theme.borderRadius.large}px;
  ${({ theme }) => theme.shadow.top}
`;

/** Inner clip layer — overflow hidden here, NOT on the shadow shell */
const Clip = styled(View)`
  flex: 1;
  border-top-left-radius: ${({ theme }) =>
    theme.borderRadius.xxLarge + theme.borderRadius.large}px;
  border-top-right-radius: ${({ theme }) =>
    theme.borderRadius.xxLarge + theme.borderRadius.large}px;
  overflow: hidden;
`;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerSideEnd: { alignItems: "flex-end" as const },
});

const HandleZone = styled(View)`
  align-items: center;
  padding-top: ${({ theme }) => theme.sizing.small}px;
  padding-bottom: ${({ theme }) => theme.sizing.xSmall}px;
`;

const HandleBar = styled(View)`
  width: ${({ theme }) => theme.sizing.xLarge + theme.sizing.xxSmall}px;
  height: ${({ theme }) => theme.sizing.xxSmall}px;
  border-radius: ${({ theme }) => theme.borderRadius.xSmall}px;
  background-color: ${({ theme }) => theme.colorBorderSecondary};
`;

const HeaderRow = styled(View)`
  flex-direction: row;
  align-items: center;
  padding-left: ${({ theme }) => theme.padding.medium}px;
  padding-right: ${({ theme }) => theme.padding.medium}px;
  padding-bottom: ${({ theme }) => theme.padding.small}px;
  border-bottom-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-bottom-color: ${({ theme }) => theme.colorBorderSecondary};
`;

const HeaderSide = styled(View)`
  flex: 1;
`;

const HeaderCenter = styled(View)`
  flex: 3;
  align-items: center;
`;
