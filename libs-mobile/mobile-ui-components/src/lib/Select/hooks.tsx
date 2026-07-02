import { useEffect, useRef, useState } from "react";
import { Animated, Dimensions, Easing } from "react-native";

export function useSelectMobile() {
  const [visible, setVisible] = useState(false);
  const [showing, setShowing] = useState(visible);
  const sheetAnim = useRef(new Animated.Value(1)).current;
  const screenHeight = Dimensions.get("window").height;

  useEffect(() => {
    if (visible) {
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
  }, [visible, sheetAnim]);

  const translateY = sheetAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, screenHeight],
  });

  return {
    translateY,
    showing,
    setVisible,
  };
}
