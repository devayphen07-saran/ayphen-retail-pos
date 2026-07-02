import { Animated } from "react-native";
import { Typography } from "./index";

/**
 * Animated versions of Typography components. Use these with Animated values
 * (scroll animations, fade-ins, etc.). Each variant is wrapped via
 * Animated.createAnimatedComponent.
 *
 * Refs propagate correctly because the underlying Typography variants are
 * built with React.forwardRef. Without forwardRef, RN would warn:
 *   "Animated: `useNativeDriver` is not supported because the native animated
 *    module is missing" — and refs would be lost.
 *
 * @example
 *   const opacity = useRef(new Animated.Value(0)).current;
 *   useEffect(() => {
 *     Animated.timing(opacity, { toValue: 1, duration: 300, useNativeDriver: true }).start();
 *   }, []);
 *
 *   return (
 *     <TypographyAnimated.H1 style={{ opacity }}>
 *       Welcome
 *     </TypographyAnimated.H1>
 *   );
 */
export const TypographyAnimated = {
  H1: Animated.createAnimatedComponent(Typography.H1),
  H2: Animated.createAnimatedComponent(Typography.H2),
  H3: Animated.createAnimatedComponent(Typography.H3),
  H4: Animated.createAnimatedComponent(Typography.H4),
  H5: Animated.createAnimatedComponent(Typography.H5),
  Subtitle: Animated.createAnimatedComponent(Typography.Subtitle),
  Body: Animated.createAnimatedComponent(Typography.Body),
  Caption: Animated.createAnimatedComponent(Typography.Caption),
  Overline: Animated.createAnimatedComponent(Typography.Overline),
} as const;

export default TypographyAnimated;