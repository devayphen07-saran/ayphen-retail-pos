import React, { useEffect, useRef } from 'react';
import { View, Animated } from 'react-native';
import styled from 'styled-components/native';

interface SkeletonLoaderProps {
  rows?: number;
}

export const SkeletonLoader: React.FC<SkeletonLoaderProps> = ({ rows = 2 }) => {
  const opacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 750, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 750, useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity]);

  return (
    <Wrapper>
      {Array.from({ length: rows }).map((_, idx) => (
        <Animated.View key={idx} style={{ opacity }}>
          <Card>
            <TopRow>
              <TitleGroup>
                <Bone style={{ width: '58%', height: 13 }} />
                <Bone style={{ width: '36%', height: 10, marginTop: 8 }} />
              </TitleGroup>
              <Bone style={{ width: 54, height: 22, borderRadius: 4 }} />
            </TopRow>
            <BottomRow>
              <Bone style={{ width: 14, height: 14, borderRadius: 7 }} />
              <Bone style={{ width: '30%', height: 10, marginLeft: 8 }} />
            </BottomRow>
          </Card>
        </Animated.View>
      ))}
    </Wrapper>
  );
};

const Wrapper = styled(View)`
  padding: ${({ theme }) => theme.sizing.small}px ${({ theme }) => theme.sizing.medium}px 0;
  gap: ${({ theme }) => theme.sizing.small}px;
`;

const Card = styled(View)`
  padding: ${({ theme }) => theme.sizing.medium}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
`;

const TopRow = styled(View)`
  flex-direction: row;
  align-items: flex-start;
  justify-content: space-between;
`;

const TitleGroup = styled(View)`
  flex: 1;
  margin-right: 16px;
`;

const BottomRow = styled(View)`
  flex-direction: row;
  align-items: center;
  margin-top: ${({ theme }) => theme.sizing.small}px;
`;

const Bone = styled(View)`
  background-color: ${({ theme }) => theme.colorFill ?? theme.colorBorder};
  border-radius: 6px;
`;
