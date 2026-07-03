import React, { ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Dimensions, Easing, Modal, View, Pressable } from "react-native";
import styled from "styled-components/native";
import { Flex } from "../layout";
import { LucideIcon } from "../lucide-icon";
import { useMobileTheme } from "@ayphen/mobile-theme";
import { ThemedFlatList } from "../flat-list-scaffold/ThemedFlatList";

type valueType = string | number | undefined | null;

export interface ModalSelectProps<T> {
  options: T[];
  renderItem: (value: T, onSelectItem: (value: T) => void, isSelected: boolean) => ReactElement;
  onChange: (value: T) => void;
  value?: valueType;
  valueKey: keyof T;
  keyExtractor?: ((item: T, index: number) => string) | undefined;
  open: boolean;
  setOpen: (value: boolean) => void;
  loading?: boolean;
  loadingRenderer?: () => ReactElement;
  noDataMessage?: string;
  Header?: React.ReactNode;
}

export function ModalSelect<T>({
  options,
  renderItem,
  value,
  onChange,
  valueKey,
  keyExtractor,
  open,
  setOpen,
  loading,
  loadingRenderer,
  noDataMessage = "No Data Found",
  Header,
}: ModalSelectProps<T>) {
  const [showing, setShowing] = useState(false);
  const sheetAnim = useRef(new Animated.Value(1)).current;
  const screenHeight = Dimensions.get("window").height;
  const { theme } = useMobileTheme();

  useEffect(() => {
    if (open) {
      setShowing(true);
      sheetAnim.setValue(1);
      Animated.timing(sheetAnim, {
        toValue: 0,
        duration: 400,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(sheetAnim, {
        toValue: 1,
        duration: 320,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => setShowing(false));
    }
  }, [open, sheetAnim]);

  const translateY = sheetAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, screenHeight],
  });

  const selectedValue = useMemo(() => {
    return options.find((item) => item?.[valueKey] === value);
  }, [value, options, valueKey]);

  return (
    <Modal visible={showing} transparent animationType="none" onRequestClose={() => setOpen(false)}>
      <Backdrop onPress={() => setOpen(false)} />
      <AnimatedSheetContainer style={{ transform: [{ translateY }] }}>
        <SheetBar />
        {Header}
        {loading ? (
          loadingRenderer ? (
            loadingRenderer()
          ) : null
        ) : options.length === 0 ? (
          <NoDataView>
            <Flex align="center" gap={10}>
              <LucideIcon name={"Box"} size={40} color={theme.colorTextSecondary} />
              <NoDataText>{noDataMessage}</NoDataText>
            </Flex>
          </NoDataView>
        ) : (
          <ThemedFlatList
            data={options}
            keyExtractor={
              keyExtractor || ((item, index) => String(item[valueKey]) + index)
            }
            scrollEnabled={true}
            renderItem={(info: { item: T; index: number }) =>
              renderItem(
                info.item,
                (i) => {
                  onChange(i);
                  setOpen(false);
                },
                selectedValue?.[valueKey] === info.item[valueKey]
              )
            }
            ItemSeparatorComponent={() => <Separator />}
            loading={false}
          />
        )}
      </AnimatedSheetContainer>
    </Modal>
  );
}

const Backdrop = styled(Pressable)`
  flex: 1;
  background-color: rgba(0, 0, 0, 0.18);
`;

const AnimatedSheetContainer = styled(Animated.View)`
  background-color: ${({ theme }) => theme.colorBgLayout};
  border-top-left-radius: ${({ theme }) => theme.borderRadius.xxLarge + theme.borderRadius.small}px;
  border-top-right-radius: ${({ theme }) => theme.borderRadius.xxLarge + theme.borderRadius.small}px;
  padding-top: ${({ theme }) => theme.sizing.small}px;
  padding-bottom: ${({ theme }) => theme.sizing.small}px;
  padding-right: 0px;
  padding-left: 0px;
  min-height: 220px;
  max-height: 50%;
  position: absolute;
  left: 0px;
  right: 0px;
  bottom: 0px;
`;

const Separator = styled(View)`
  height: ${({ theme }) => theme.borderWidth.mild}px;
  background-color: ${({ theme }) => theme.colorBorder};
  margin-left: ${({ theme }) => theme.margin.small}px;
  margin-right: ${({ theme }) => theme.margin.small}px;
`;

const SheetBar = styled(View)`
  align-self: center;
  width: ${({ theme }) => theme.sizing.xLarge + theme.sizing.xxSmall}px;
  height: ${({ theme }) => theme.sizing.xxSmall + theme.borderWidth.medium}px;
  border-radius: ${({ theme }) => theme.borderRadius.xSmall}px;
  background-color: ${({ theme }) => theme.colorBorder};
  margin-bottom: ${({ theme }) => theme.sizing.xSmall}px;
`;

const NoDataView = styled(View)`
  align-items: center;
  justify-content: center;
  flex: 1;
  padding-top: ${({ theme }) => theme.sizing.regular}px;
  padding-bottom: ${({ theme }) => theme.sizing.regular}px;
`;

const NoDataText = styled.Text`
  color: ${({ theme }) => theme.colorTextSecondary};
  font-size: ${({ theme }) => theme.fontSize.small}px;
`;
