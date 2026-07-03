import React, { useEffect, useRef } from "react";
import { Animated, View } from "react-native";
import styled from "styled-components/native";
import { Separator } from "./styles";

interface Props {
  rows?: number;
}

/**
 * Loading placeholder shaped like the picker's own rows (a single label +
 * optional check icon, per ConfigSelectItem) — SkeletonLoader's title/
 * subtitle/badge card layout is for list-scaffold cards elsewhere in the app
 * and doesn't match a one-line select row.
 */
export function SelectSkeleton({ rows = 6 }: Props) {
  const opacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 750, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 750, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity]);

  return (
    <View>
      {Array.from({ length: rows }).map((_, idx) => (
        <React.Fragment key={idx}>
          <Row>
            <Animated.View style={{ opacity }}>
              <Bone style={{ width: `${45 + ((idx * 13) % 35)}%` }} />
            </Animated.View>
          </Row>
          {idx < rows - 1 && <Separator />}
        </React.Fragment>
      ))}
    </View>
  );
}

const Row = styled(View)`
  height: 48px;
  justify-content: center;
  padding-horizontal: ${({ theme }) => theme.sizing.medium}px;
`;

const Bone = styled(View)`
  height: 14px;
  border-radius: ${({ theme }) => theme.borderRadius.small}px;
  background-color: ${({ theme }) => theme.colorFill ?? theme.colorBorder};
`;