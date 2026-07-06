import React, { ReactNode, createContext, useContext, useEffect } from 'react';
import { TouchableOpacity, useWindowDimensions } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import styled from 'styled-components/native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { LucideIcon } from '../lucide-icon';
import { Typography } from '../typography';

/**
 * True when something above the screen (e.g. a global offline banner) already
 * covers the top safe-area inset. AppLayout reads this to avoid adding the
 * inset a second time, which would leave a gap below the banner.
 */
const TopInsetConsumedContext = createContext(false);

/** Wrap the screen subtree below a top banner so AppLayout skips its own
 *  top safe-area padding (the banner already cleared the notch). */
export function TopInsetConsumedProvider({
  value,
  children,
}: {
  value: boolean;
  children: ReactNode;
}): React.ReactElement {
  return (
    <TopInsetConsumedContext.Provider value={value}>
      {children}
    </TopInsetConsumedContext.Provider>
  );
}

export interface AppLayoutProps {
  title: string;
  children: ReactNode;
  rightElement?: React.ReactNode;
  leftElement?: React.ReactNode;
  /** Replaces the entire header row. Use when the default title+slots layout
   *  can't express the desired design (e.g. a two-line greeting + store row). */
  headerRow?: React.ReactNode;
  onMenuPress?: () => void;
  onBack?: () => void;
  /** Show the indeterminate sync progress bar at the bottom of the header. */
  loading?: boolean;
}

export function AppLayout({
  children,
  title,
  rightElement,
  leftElement,
  headerRow,
  onMenuPress,
  onBack,
  loading = false,
}: AppLayoutProps) {
  const { top } = useSafeAreaInsets();
  const topInsetConsumed = useContext(TopInsetConsumedContext);

  const resolvedLeft =
    leftElement ??
    (onBack ? (
      <TouchableOpacity
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={8}
      >
        <LucideIcon name="ChevronLeft" size={24} />
      </TouchableOpacity>
    ) : onMenuPress ? (
      <TouchableOpacity
        onPress={onMenuPress}
        accessibilityRole="button"
        accessibilityLabel="Open menu"
        hitSlop={8}
      >
        <LucideIcon name="Menu" size={24} />
      </TouchableOpacity>
    ) : null);

  const hasLeft = resolvedLeft !== null;

  return (
    <StyledSafeArea edges={[]} style={{ paddingTop: topInsetConsumed ? 0 : top }}>
      {headerRow ? headerRow : (
        <Header>
          {hasLeft ? <SideSlot>{resolvedLeft}</SideSlot> : <LeadingGap />}

          <TitleText numberOfLines={1} accessibilityRole="header">
            {title}
          </TitleText>

          {rightElement ? <SideSlot>{rightElement}</SideSlot> : <TrailingGap />}
        </Header>
      )}

      <SyncProgressBar loading={loading} />

      <ContentContainer>{children}</ContentContainer>
    </StyledSafeArea>
  );
}

export default AppLayout;

// ─── Sync progress bar ───────────────────────────────────────────────────────

function SyncProgressBar({ loading }: { loading: boolean }) {
  const { width: screenWidth } = useWindowDimensions();
  const translateX = useSharedValue(-screenWidth * 0.5);

  useEffect(() => {
    if (loading) {
      translateX.value = -screenWidth * 0.5;
      translateX.value = withRepeat(
        withTiming(screenWidth, { duration: 1400, easing: Easing.linear }),
        -1,
        false,
      );
    } else {
      cancelAnimation(translateX);
      translateX.value = -screenWidth * 0.5;
    }
  }, [loading, screenWidth, translateX]);

  const barStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  if (!loading) return null;

  return (
    <ProgressTrack>
      <ProgressFill style={barStyle} />
    </ProgressTrack>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const StyledSafeArea = styled(SafeAreaView)`
  flex: 1;
  background-color: ${({ theme }) => theme.colorBgContainer};
`;

const Header = styled.View`
  /* 64px header height — touch-target/layout constant, no sizing token */
  min-height: 64px;
  flex-direction: row;
  align-items: center;
  padding-right: ${({ theme }) => theme.padding.small}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
`;

/* sizing.regular (20px) left padding when there's no left element, aligning title to content */
const LeadingGap = styled.View`
  width: ${({ theme }) => theme.sizing.regular}px;
`;

const TrailingGap = styled.View`
  width: ${({ theme }) => theme.sizing.regular}px;
`;

const SideSlot = styled.View`
  /* 44px — standard minimum touch target, no sizing token (48 would change it) */
  min-width: 44px;
  min-height: 44px;
  align-items: center;
  justify-content: center;
`;

const TitleText = styled(Typography.H4)`
  flex: 1;
  text-align: left;
`;

const ContentContainer = styled.View`
  flex: 1;
  background-color: ${({ theme }) => theme.colorBgLayout};
`;

const ProgressTrack = styled.View`
  /* 3px: thin indeterminate progress bar — off the sizing scale (0 → 4 gap), no clean token */
  height: 3px;
  overflow: hidden;
  /* colorPrimaryBg approximates the former primary@~20%-alpha track tint (no primary-alpha token exists) */
  background-color: ${({ theme }) => theme.colorPrimaryBg};
`;

const ProgressFill = styled(Animated.View)`
  position: absolute;
  top: 0;
  left: 0;
  width: 50%;
  /* 3px: matches ProgressTrack height — off-scale hairline, no sizing token */
  height: 3px;
  border-radius: ${({ theme }) => theme.borderRadius.xSmall}px;
  background-color: ${({ theme }) => theme.colorPrimary};
`;
