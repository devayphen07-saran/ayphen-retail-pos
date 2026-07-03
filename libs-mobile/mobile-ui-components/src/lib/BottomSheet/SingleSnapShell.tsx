import React, { useEffect } from "react";
import {
  AccessibilityInfo,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
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

const SPRING = { damping: 20, stiffness: 200, mass: 0.8 };
const CLOSE_DISTANCE = 80;
const CLOSE_VELOCITY = 600;
const RATIO: Record<string, number> = { sm: 0.35, md: 0.55, lg: 0.8, full: 1 };

interface Props {
  config: BottomSheetConfig;
  configRef: React.RefObject<BottomSheetConfig | null>;
  onAnimatedClose: () => void;
}

export function SingleSnapShell({ config, configRef, onAnimatedClose }: Props) {
  const styles = useSheetStyles();
  const insets = useSafeAreaInsets();
  const { height: SCREEN_H } = useWindowDimensions(); // live — survives rotation
  const snapHeight = SCREEN_H * (RATIO[config.snapPoint ?? "md"] ?? RATIO.md);

  const translateY = useSharedValue(snapHeight); // start offscreen (no flicker)
  const backdrop = useSharedValue(0);
  const [reduceMotion, setReduceMotion] = React.useState(config.reduceMotion ?? false);

  useEffect(() => {
    if (config.reduceMotion !== undefined) return;
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (!cancelled) setReduceMotion(v);
    });
    return () => {
      cancelled = true;
    };
  }, [config.reduceMotion]);

  useEffect(() => {
    translateY.value = reduceMotion
      ? withTiming(0, { duration: 0 }, () => {
          if (config.onOpen) scheduleOnRN(config.onOpen);
        })
      : withSpring(0, SPRING, () => {
          if (config.onOpen) scheduleOnRN(config.onOpen);
        });
    backdrop.value = withTiming(1, { duration: reduceMotion ? 0 : 250 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  // Close entirely on the UI thread; only the JS callback crosses via runOnJS.
  const animatedClose = () => {
    "worklet";
    if (configRef.current?.reduceMotion) {
      translateY.value = withTiming(snapHeight, { duration: 0 }, (done) => {
        if (done) scheduleOnRN(onAnimatedClose);
      });
      backdrop.value = withTiming(0, { duration: 0 });
      return;
    }
    translateY.value = withSpring(snapHeight, SPRING, (done) => {
      if (done) scheduleOnRN(onAnimatedClose);
    });
    backdrop.value = withTiming(0, { duration: 200 });
  };
  const jsClose = () => {
    if (!configRef.current?.preventClose) animatedClose();
  };

  // Android hardware back — respects preventClose
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (configRef.current?.preventClose) return false;
      jsClose();
      return true; // consume
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dragStart = useSharedValue(0);
  const drag = Gesture.Pan()
    .onStart(() => {
      "worklet";
      dragStart.value = translateY.value;
    })
    .onUpdate((e) => {
      "worklet";
      translateY.value = Math.max(0, dragStart.value + e.translationY);
    })
    .onEnd((e) => {
      "worklet";
      const shouldClose = e.translationY > CLOSE_DISTANCE || e.velocityY > CLOSE_VELOCITY;
      if (shouldClose && !configRef.current?.preventClose) animatedClose();
      else translateY.value = withSpring(0, SPRING); // rubber-band back
    })
    .enabled(!config.preventClose);

  const backdropTap = Gesture.Tap().onEnd(() => {
    "worklet";
    if (config.closeOnBackdrop !== false && !configRef.current?.preventClose) animatedClose();
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
            height: snapHeight,
            backgroundColor: styles.sheetBackgroundColor,
            borderTopLeftRadius: styles.sheetRadius,
            borderTopRightRadius: styles.sheetRadius,
            paddingBottom: insets.bottom,
          },
          sheetStyle,
        ]}
      >
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          {config.showHandle !== false && (
            <GestureDetector gesture={drag}>
              <View
                style={{ alignItems: "center", paddingVertical: styles.spacing.xSmall }}
                accessibilityRole="adjustable"
                accessibilityLabel="Drag to close"
                accessibilityHint="Drag down to dismiss"
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
          <View style={{ flex: 1 }}>
            <config.Component {...(config.props ?? {})} />
          </View>
        </KeyboardAvoidingView>
      </Animated.View>
    </View>
  );
}

const sheetLayout = StyleSheet.create({
  sheet: { position: "absolute", bottom: 0, left: 0, right: 0, overflow: "hidden" },
});
