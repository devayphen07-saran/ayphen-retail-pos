import React, { ReactNode } from "react";
import {
  Modal,
  Platform,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
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
        <Sheet style={[styles.sheet, { height }]}>
          <View style={styles.clip}>
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
          </View>
        </Sheet>
      </Backdrop>
    </Modal>
  );
};

export default BottomSheetModal;

// ─── Styles ─────────────────────────────────────────────────────────────────

const Backdrop = styled(TouchableOpacity)`
  flex: 1;
  background-color: rgba(0, 0, 0, 0.45);
  justify-content: flex-end;
`;

/** Outer shell carries the shadow — no overflow:hidden so shadow escapes. */
const Sheet = styled(View)`
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-top-left-radius: 24px;
  border-top-right-radius: 24px;
`;

const styles = StyleSheet.create({
  sheet: {
    // Platform shadow — kept in StyleSheet so shadowOffset object is valid
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: -6 },
        shadowOpacity: 0.12,
        shadowRadius: 20,
      },
      android: {
        elevation: 24,
      },
    }),
  },
  /** Inner clip layer — overflow hidden here, NOT on the shadow shell */
  clip: {
    flex: 1,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: "hidden",
  },
  flex: { flex: 1 },
  headerSideEnd: { alignItems: "flex-end" as const },
});

const HandleZone = styled(View)`
  align-items: center;
  padding-top: 12px;
  padding-bottom: 8px;
`;

const HandleBar = styled(View)`
  width: 40px;
  height: 4px;
  border-radius: 2px;
  background-color: ${({ theme }) => theme.colorBorderSecondary};
`;

const HeaderRow = styled(View)`
  flex-direction: row;
  align-items: center;
  padding-left: ${({ theme }) => theme.padding.medium}px;
  padding-right: ${({ theme }) => theme.padding.medium}px;
  padding-bottom: ${({ theme }) => theme.padding.small}px;
  border-bottom-width: 1px;
  border-bottom-color: ${({ theme }) => theme.colorBorderSecondary};
`;

const HeaderSide = styled(View)`
  flex: 1;
`;

const HeaderCenter = styled(View)`
  flex: 3;
  align-items: center;
`;
