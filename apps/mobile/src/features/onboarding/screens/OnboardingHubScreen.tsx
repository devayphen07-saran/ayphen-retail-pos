import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Image,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  TouchableOpacity,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import styled from 'styled-components/native';
import { useQueryClient } from '@tanstack/react-query';

import { useMobileTheme } from '@ayphen/mobile-theme';
import { Alert, LucideIcon, Typography } from '@ayphen/mobile-ui-components';
import {
  prefetchGlobalLookup,
  prefetchStates,
  prefetchCurrencies,
} from '@ayphen/api-manager';

import { useAuthStore } from '@features/auth/authStore';
import { useAuth } from '@core/providers/AuthProvider';
import { BUSINESS_CATEGORY_TYPE } from '@features/store/selects/BusinessTypeSelect';

type SlideTint = 'primary' | 'violet' | 'green' | 'orange';

const STOREFRONT_IMG = require('../../../../assets/images/storefront.png');
const POS_IMG = require('../../../../assets/images/pos.png');
const INVENTORY_IMG = require('../../../../assets/images/inventory.png');
const SALES_IMG = require('../../../../assets/images/sales.png');

interface Slide {
  imageSource: any;
  tint: SlideTint;
  title: string;
  caption: string;
}

const SLIDES: Slide[] = [
  {
    imageSource: STOREFRONT_IMG,
    tint: 'primary',
    title: 'Storefront',
    caption: 'Set up your store profile in minutes',
  },
  {
    imageSource: POS_IMG,
    tint: 'orange',
    title: 'Point of Sale (POS)',
    caption: 'Process checkouts and billings smoothly',
  },
  {
    imageSource: INVENTORY_IMG,
    tint: 'violet',
    title: 'Inventory',
    caption: 'Track stock levels in real time',
  },
  {
    imageSource: SALES_IMG,
    tint: 'green',
    title: 'Sales',
    caption: 'See performance at a glance',
  },
];

const AUTOPLAY_INTERVAL_MS = 3200;
const CARD_HEIGHT = 220;
const MAX_CARD_WIDTH = 420;
const MIN_CARD_WIDTH = 230;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Onboarding Hub — pure navigation gate for "no store access yet".
 *
 * This screen features an interactive card carousel previewing Ayphen's core
 * business tools, alongside direct options to create a store or check invites.
 */
export function OnboardingHubScreen() {
  const { theme } = useMobileTheme();
  const { width: screenWidth } = useWindowDimensions();
  const { refetchUser, logout, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const pendingCount = useAuthStore((s) => s.pendingInvitationCount);
  const hasInvites = pendingCount > 0;

  // Warm the create-store wizard's dropdown data (step 4: category, state,
  // currency) while the user is still browsing this hub, so tapping "Create
  // your store" never shows a loading spinner for reference data that never
  // changes per-session.
  useEffect(() => {
    if (!isAuthenticated) return;
    void prefetchGlobalLookup(queryClient, BUSINESS_CATEGORY_TYPE);
    void prefetchStates(queryClient);
    void prefetchCurrencies(queryClient);
  }, [isAuthenticated, queryClient]);

  const scrollRef = useRef<ScrollView>(null);
  const scrollX = useRef(new Animated.Value(0)).current;
  const isFocusedRef = useRef(false);
  const isDraggingRef = useRef(false);

  const [activeIndex, setActiveIndex] = useState(0);

  const layout = useMemo(() => {
    const cardWidth = clamp(screenWidth * 0.65, MIN_CARD_WIDTH, MAX_CARD_WIDTH);
    const cardGap = 12;
    const sidePadding = Math.max((screenWidth - cardWidth) / 2, theme.sizing.large);
    const snapInterval = cardWidth + cardGap;

    return {
      cardWidth,
      cardGap,
      sidePadding,
      snapInterval,
    };
  }, [screenWidth, theme.sizing.large]);

  const scrollToIndex = useCallback(
    (index: number, animated = true) => {
      const nextIndex = clamp(index, 0, SLIDES.length - 1);

      scrollRef.current?.scrollTo({
        x: nextIndex * layout.snapInterval,
        animated,
      });

      setActiveIndex(nextIndex);
    },
    [layout.snapInterval],
  );

  const handleLogout = useCallback(() => {
    Alert.confirm(
      'Log out',
      'You will need to sign in again to access your stores.',
      () => {
        void logout();
      },
      'Log out',
      'destructive',
    );
  }, [logout]);

  const handleOpenInvitations = useCallback(() => {
    router.push('/(onboarding)/invitations');
  }, []);

  const handleCreateStore = useCallback(() => {
    router.push('/(onboarding)/create-store');
  }, []);

  const handleScrollBeginDrag = useCallback(() => {
    isDraggingRef.current = true;
  }, []);

  const handleMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      isDraggingRef.current = false;

      const rawIndex =
        event.nativeEvent.contentOffset.x / layout.snapInterval;

      const nextIndex = clamp(Math.round(rawIndex), 0, SLIDES.length - 1);

      setActiveIndex(nextIndex);
    },
    [layout.snapInterval],
  );

  const handleScrollEndDrag = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  useFocusEffect(
    useCallback(() => {
      isFocusedRef.current = true;
      void refetchUser();

      return () => {
        isFocusedRef.current = false;
      };
    }, [refetchUser]),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      if (!isFocusedRef.current || isDraggingRef.current) {
        return;
      }

      setActiveIndex((currentIndex) => {
        const nextIndex = (currentIndex + 1) % SLIDES.length;

        scrollRef.current?.scrollTo({
          x: nextIndex * layout.snapInterval,
          animated: true,
        });

        return nextIndex;
      });
    }, AUTOPLAY_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [layout.snapInterval]);

  useEffect(() => {
    scrollToIndex(activeIndex, false);
    // Keep carousel aligned after width/orientation change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.snapInterval]);

  return (
    <Root edges={['top', 'bottom']}>
      <TopBar>
        <TouchableOpacity
          onPress={handleLogout}
          accessibilityRole="button"
          accessibilityLabel="Log out"
          activeOpacity={0.75}
          hitSlop={8}
        >
          <IconCircle>
            <LucideIcon name="LogOut" size={20} color={theme.colorText} />
          </IconCircle>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handleOpenInvitations}
          accessibilityRole="button"
          accessibilityLabel={
            hasInvites
              ? `${pendingCount} pending invitation${
                  pendingCount === 1 ? '' : 's'
                }`
              : 'Invitations'
          }
          activeOpacity={0.75}
          hitSlop={8}
        >
          <BadgeIconWrap>
            <IconCircle>
              <LucideIcon name="Mail" size={20} color={theme.colorText} />
            </IconCircle>

            {hasInvites ? (
              <BadgeDot>
                <BadgeDotText>
                  {pendingCount > 9 ? '9+' : pendingCount}
                </BadgeDotText>
              </BadgeDot>
            ) : null}
          </BadgeIconWrap>
        </TouchableOpacity>
      </TopBar>

      <CenterArea>
        <AnimatedCarousel
          ref={scrollRef as any}
          horizontal
          pagingEnabled={false}
          decelerationRate="fast"
          snapToInterval={layout.snapInterval}
          snapToAlignment="start"
          showsHorizontalScrollIndicator={false}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { x: scrollX } } }],
            { useNativeDriver: true }
          )}
          scrollEventThrottle={16}
          onScrollBeginDrag={handleScrollBeginDrag}
          onScrollEndDrag={handleScrollEndDrag}
          onMomentumScrollEnd={handleMomentumScrollEnd}
          contentContainerStyle={{
            paddingHorizontal: layout.sidePadding,
            paddingVertical: 24,
            gap: layout.cardGap,
          }}
        >
          {SLIDES.map((slide, index) => {
            const inputRange = [
              (index - 1) * layout.snapInterval,
              index * layout.snapInterval,
              (index + 1) * layout.snapInterval,
            ];

            const scale = scrollX.interpolate({
              inputRange,
              outputRange: [0.92, 1.02, 0.92],
              extrapolate: 'clamp',
            });

            const opacity = scrollX.interpolate({
              inputRange,
              outputRange: [0.75, 1, 0.75],
              extrapolate: 'clamp',
            });

            return (
              <Animated.View
                key={slide.title}
                style={{
                  width: layout.cardWidth,
                  transform: [{ scale }],
                  opacity,
                }}
              >
                <SlideCard>
                  <SlideImage source={slide.imageSource} resizeMode="cover" />
                </SlideCard>
              </Animated.View>
            );
          })}
        </AnimatedCarousel>

        <Gap $h={16} />

        <SlideTextContainer>
          <Typography.Body
            weight="bold"
            color={theme.colorText}
            style={{ letterSpacing: 0.1, textAlign: 'center' }}
          >
            {SLIDES[activeIndex].title}
          </Typography.Body>
          <Gap $h={4} />
          <Typography.Caption
            color={theme.colorTextSecondary}
            style={{ textAlign: 'center', lineHeight: 16 }}
          >
            {SLIDES[activeIndex].caption}
          </Typography.Caption>
        </SlideTextContainer>

        <Gap $h={16} />

        <DotsRow>
          {SLIDES.map((slide, index) => (
            <Dot
              key={slide.title}
              $active={index === activeIndex}
              accessibilityRole="none"
            />
          ))}
        </DotsRow>
      </CenterArea>

      <Gap $h={16} />

      <TextBlock>
        <Typography.H2 style={{ textAlign: 'center' }} color={theme.colorText}>
          Let's set up your store
        </Typography.H2>

        <Gap $h={8} />

        <Subtitle color={theme.colorTextSecondary}>
          Add a few details about your business and start selling in minutes.
        </Subtitle>
      </TextBlock>

      <Gap $h={24} />

      <Footer>
        <PillButton
          onPress={handleCreateStore}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Create your store"
        >
          <PillButtonText>Create your store</PillButtonText>

          <LucideIcon
            name="ArrowRight"
            size={18}
            color={theme.colorBgContainer}
          />
        </PillButton>
      </Footer>
    </Root>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const Root = styled(SafeAreaView)`
  flex: 1;
  background-color: ${({ theme }) => theme.colorBgContainer};
`;

const TopBar = styled.View`
  flex-direction: row;
  justify-content: flex-end;
  align-items: center;
  gap: ${({ theme }) => theme.sizing.small}px;
  min-height: 44px;
  padding-horizontal: ${({ theme }) => theme.sizing.large}px;
`;

const CenterArea = styled.View`
  flex: 1;
  align-items: center;
  justify-content: center;
`;

const Carousel = styled(ScrollView)`
  flex-grow: 0;
  height: ${CARD_HEIGHT + 56}px;
  background-color: transparent;
`;

const AnimatedCarousel = Animated.createAnimatedComponent(Carousel);

const TextBlock = styled.View`
  align-items: center;
  padding-horizontal: ${({ theme }) => theme.sizing.xLarge}px;
`;

const Footer = styled.View`
  padding-horizontal: ${({ theme }) => theme.sizing.large}px;
  padding-bottom: ${({ theme }) => theme.sizing.large}px;
`;

const Overline = styled(Typography.Caption)`
  font-weight: 700;
  letter-spacing: 1.4px;
  text-transform: uppercase;
`;

const Gap = styled.View<{ $h: number }>`
  height: ${({ $h }) => $h}px;
`;

const Subtitle = styled(Typography.Body)`
  text-align: center;
  max-width: 280px;
`;

const DotsRow = styled.View`
  flex-direction: row;
  align-items: center;
  gap: 6px;
`;

const Dot = styled.View<{ $active: boolean }>`
  width: ${({ $active }) => ($active ? 18 : 6)}px;
  height: 6px;
  border-radius: 3px;
  background-color: ${({ $active, theme }) =>
    $active ? theme.colorPrimary : theme.colorBorder};
`;

const PillButton = styled(TouchableOpacity)`
  flex-direction: row;
  align-items: center;
  justify-content: center;
  align-self: stretch;
  gap: 8px;
  background-color: ${({ theme }) => theme.colorPrimary};
  border-radius: 100px;
  padding-vertical: 16px;
`;

const PillButtonText = styled(Typography.Body)`
  font-weight: 600;
  color: ${({ theme }) => theme.colorBgContainer};
  letter-spacing: 0.2px;
`;

const SlideCard = styled.View`
  height: ${CARD_HEIGHT}px;
  border-radius: 20px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-width: 1px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
  shadow-color: #0d0b26;
  shadow-offset: 0px 4px;
  shadow-opacity: 0.03;
  shadow-radius: 8px;
  elevation: 1;
  width: 100%;
  overflow: hidden;
`;

const SlideImage = styled(Image)`
  width: 100%;
  height: 100%;
`;

const SlideTextContainer = styled.View`
  align-items: center;
  justify-content: center;
  height: 64px;
  padding-horizontal: ${({ theme }) => theme.sizing.xLarge}px;
  width: 100%;
`;

const IconCircle = styled.View`
  width: 40px;
  height: 40px;
  border-radius: 20px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme }) => theme.color.grey.bg};
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
`;

const BadgeIconWrap = styled.View`
  position: relative;
`;

const BadgeDot = styled.View`
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 16px;
  height: 16px;
  border-radius: 8px;
  padding-horizontal: 3px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme }) => theme.colorError};
  border-width: 1.5px;
  border-color: ${({ theme }) => theme.colorBgContainer};
`;

const BadgeDotText = styled(Typography.Caption)`
  font-size: 10px;
  line-height: 12px;
  color: white;
  font-weight: 700;
`;