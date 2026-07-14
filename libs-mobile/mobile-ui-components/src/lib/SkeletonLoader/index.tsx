import React, { useEffect, useRef } from 'react';
import { View, Animated } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';

interface SkeletonLoaderProps {
  rows?: number;
}

export const SkeletonLoader: React.FC<SkeletonLoaderProps> = ({ rows = 2 }) => {
  const { theme } = useMobileTheme();
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
                <Bone $width="58%" $height={theme.sizing.small} />
                <Bone $width="36%" $height={theme.sizing.small} $marginTop={theme.sizing.xSmall} />
              </TitleGroup>
              <Bone
                $width={theme.sizing.xxLarge}
                $height={theme.sizing.large}
                $borderRadius={theme.borderRadius.small}
              />
            </TopRow>
            <BottomRow>
              <Bone
                $width={theme.sizing.medium}
                $height={theme.sizing.medium}
                $borderRadius={theme.borderRadius.full}
              />
              <Bone $width="30%" $height={theme.sizing.small} $marginLeft={theme.sizing.xSmall} />
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
  margin-right: ${({ theme }) => theme.sizing.medium}px;
`;

const BottomRow = styled(View)`
  flex-direction: row;
  align-items: center;
  margin-top: ${({ theme }) => theme.sizing.small}px;
`;

const Bone = styled(View)<{
  $width: string | number;
  $height: number;
  $borderRadius?: number;
  $marginTop?: number;
  $marginLeft?: number;
}>`
  background-color: ${({ theme }) => theme.colorFill ?? theme.colorBorder};
  border-radius: ${({ theme, $borderRadius }) => $borderRadius ?? theme.borderRadius.medium}px;
  width: ${({ $width }) => (typeof $width === 'number' ? `${$width}px` : $width)};
  height: ${({ $height }) => $height}px;
  margin-top: ${({ $marginTop }) => $marginTop ?? 0}px;
  margin-left: ${({ $marginLeft }) => $marginLeft ?? 0}px;
`;
