import React, { useEffect, useRef, useState } from "react";
import { BackHandler, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Typography } from "../typography";
import { useSheetStyles } from "./useSheetStyles";
import type { BottomSheetConfig } from "./types";

const SPRING = { damping: 22, stiffness: 220, mass: 0.9 };
const DIST = 60;
const VEL = 600;

interface Props {
  config: BottomSheetConfig;
  configRef: React.RefObject<BottomSheetConfig | null>;
  onAnimatedClose: () => void;
}

export function MultiSnapShell({ config, configRef, onAnimatedClose }: Props) {
  const styles = useSheetStyles();
  const insets = useSafeAreaInsets();
  const { height: SCREEN_H } = useWindowDimensions();
  const SNAP_HALF = SCREEN_H * 0.5;
  const SNAP_FULL = SCREEN_H * 0.92;
  const yHalf = SCREEN_H - SNAP_HALF;
  const yFull = SCREEN_H - SNAP_FULL;

  const translateY = useSharedValue(SCREEN_H);
  const backdrop = useSharedValue(0);
  const snapSV = useSharedValue<"half" | "full">(config.initialSnap ?? "half"); // SINGLE source
  const scrollAtTop = useSharedValue(true);
  const [currentSnap, setCurrentSnap] = useState<"half" | "full">(config.initialSnap ?? "half");
  const scrollRef = useRef<ScrollView>(null);

  // React state is a PROJECTION of the shared value (drives scrollEnabled) — no desync.
  useAnimatedReaction(
    () => snapSV.value,
    (v, prev) => {
      if (v !== prev) scheduleOnRN(setCurrentSnap, v);
    }
  );

  useEffect(() => {
    translateY.value = withSpring(config.initialSnap === "full" ? yFull : yHalf, SPRING);
    backdrop.value = withTiming(1, { duration: 250 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const snapTo = (target: "half" | "full" | "close") => {
    "worklet";
    if (target === "close") {
      translateY.value = withSpring(SCREEN_H, SPRING, (d) => {
        if (d) scheduleOnRN(onAnimatedClose);
      });
      backdrop.value = withTiming(0, { duration: 200 });
      return;
    }
    snapSV.value = target; // updates source; reaction updates React
    translateY.value = withSpring(target === "full" ? yFull : yHalf, SPRING);
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (configRef.current?.preventClose) return false;
      snapTo("close");
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dragStart = useSharedValue(0);
  const handleGesture = Gesture.Pan()
    .onStart(() => {
      "worklet";
      dragStart.value = translateY.value;
    })
    .onUpdate((e) => {
      "worklet";
      translateY.value = Math.max(yFull, dragStart.value + e.translationY);
    })
    .onEnd((e) => {
      "worklet";
      const up = e.translationY < -DIST || e.velocityY < -VEL;
      const down = e.translationY > DIST || e.velocityY > VEL;
      if (configRef.current?.preventClose) {
        translateY.value = withSpring(snapSV.value === "full" ? yFull : yHalf, SPRING);
        return;
      }
      if (snapSV.value === "half") {
        if (up) snapTo("full");
        else if (down) snapTo("close");
        else snapTo("half");
      } else {
        if (down) snapTo("half");
        else snapTo("full");
      }
    })
    .enabled(!config.preventClose);

  // Content pan: only take over when at top AND dragging down (decided in onUpdate, not onStart).
  const active = useSharedValue(false);
  const contentGesture = Gesture.Pan()
    .onUpdate((e) => {
      "worklet";
      if (!active.value) {
        if (scrollAtTop.value && e.translationY > 0 && snapSV.value === "full") {
          active.value = true;
          dragStart.value = translateY.value;
        } else return;
      }
      translateY.value = Math.max(yFull, dragStart.value + e.translationY);
    })
    .onEnd((e) => {
      "worklet";
      if (!active.value) return;
      active.value = false;
      if (e.translationY > DIST || e.velocityY > VEL) snapTo("half");
      else snapTo("full");
    })
    .simultaneousWithExternalGesture(scrollRef as unknown as React.RefObject<React.ComponentType<object>>); // REAL ref — the handoff

  const backdropTap = Gesture.Tap().onEnd(() => {
    "worklet";
    if (config.closeOnBackdrop !== false && !configRef.current?.preventClose) snapTo("close");
  });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <GestureDetector gesture={backdropTap}>
        <Animated.View
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={[StyleSheet.absoluteFill, { backgroundColor: styles.backdropColor }, backdropStyle]}
        />
      </GestureDetector>

      <Animated.View
        accessibilityViewIsModal
        accessibilityLabel={config.title ?? "Bottom sheet"}
        style={[
          sheetLayout.sheet,
          {
            height: SNAP_FULL,
            backgroundColor: styles.sheetBackgroundColor,
            borderTopLeftRadius: styles.sheetRadius,
            borderTopRightRadius: styles.sheetRadius,
            paddingBottom: insets.bottom,
          },
          sheetStyle,
        ]}
      >
        {config.showHandle !== false && (
          <GestureDetector gesture={handleGesture}>
            <View
              style={{ alignItems: "center", paddingVertical: styles.spacing.xSmall }}
              accessibilityRole="adjustable"
              accessibilityLabel="Drag to resize"
              accessibilityHint="Drag up to expand, down to collapse or dismiss"
            >
              <View
                style={{
                  width: 36,
                  height: 4,
                  borderRadius: styles.borderRadius.step,
                  backgroundColor: styles.handleColor,
                }}
              />
            </View>
          </GestureDetector>
        )}
        {(config.title || config.subtitle) && (
          <View
            style={{
              paddingHorizontal: styles.spacing.medium,
              paddingBottom: styles.spacing.small,
              borderBottomWidth: styles.headerBorderWidth,
              borderBottomColor: styles.headerBorderColor,
            }}
          >
            {config.title && <Typography.H5>{config.title}</Typography.H5>}
            {config.subtitle && <Typography.Caption>{config.subtitle}</Typography.Caption>}
          </View>
        )}
        <GestureDetector gesture={contentGesture}>
          <ScrollView
            ref={scrollRef}
            onScroll={(e) => {
              scrollAtTop.value = e.nativeEvent.contentOffset.y <= 0;
            }}
            scrollEventThrottle={16}
            bounces={false}
            keyboardShouldPersistTaps="handled"
            scrollEnabled={currentSnap === "full"} // the handoff key
            contentContainerStyle={{ flexGrow: 1 }}
          >
            <config.Component {...(config.props ?? {})} />
          </ScrollView>
        </GestureDetector>
      </Animated.View>
    </View>
  );
}

const sheetLayout = StyleSheet.create({
  sheet: { position: "absolute", bottom: 0, left: 0, right: 0, overflow: "hidden" },
});
