import React, { useEffect, useRef } from 'react';
import { Animated, ViewProps } from 'react-native';
import styled from 'styled-components/native';

interface SkeletonBoxProps extends ViewProps {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  $fullWidth?: boolean;
}

export const SkeletonBox: React.FC<SkeletonBoxProps> = ({
  width = '100%',
  height = 16,
  borderRadius = 6,
  $fullWidth = false,
  style,
  ...rest
}) => {
  const shimmerAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmerAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(shimmerAnim, {
          toValue: 0,
          duration: 1000,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [shimmerAnim]);

  const opacity = shimmerAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 0.7],
  });

  return (
    <ShimmerBase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      style={[{ width: $fullWidth ? '100%' : width, height, borderRadius, opacity } as any, style]}
      {...rest}
    />
  );
};

export default SkeletonBox;

const ShimmerBase = styled(Animated.View)`
  background-color: ${({ theme }) => theme.colorBorderSecondary};
`;
