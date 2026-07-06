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
import { Alert, Column, LucideIcon, Row, Typography } from '@ayphen/mobile-ui-components';
import {
  prefetchGlobalLookup,
  prefetchStates,
  prefetchCurrencies,
} from '@ayphen/api-manager';

import { useAuthStore } from '@store';
import { useAuth } from '@core/providers/AuthProvider';
import { BUSINESS_CATEGORY_TYPE } from '@features/store';

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
      <Row
        justify="flex-end"
        align="center"
        gap={theme.sizing.small}
        style={{ minHeight: 44, paddingHorizontal: theme.sizing.large }}
      >
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
                <Typography.Caption
                  weight={700}
                  color={theme.colorWhite}
                  style={{ fontSize: 10, lineHeight: 12 }}
                >
                  {pendingCount > 9 ? '9+' : pendingCount}
                </Typography.Caption>
              </BadgeDot>
            ) : null}
          </BadgeIconWrap>
        </TouchableOpacity>
      </Row>

      <Column flex={1} align="center" justify="center">
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

        <Column
          align="center"
          justify="center"
          height={64}
          width="100%"
          style={{ paddingHorizontal: theme.sizing.xLarge }}
        >
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
        </Column>

        <Gap $h={16} />

        <Row align="center" gap={6}>
          {SLIDES.map((slide, index) => (
            <Dot
              key={slide.title}
              $active={index === activeIndex}
              accessibilityRole="none"
            />
          ))}
        </Row>
      </Column>

      <Gap $h={16} />

      <Column align="center" style={{ paddingHorizontal: theme.sizing.xLarge }}>
        <Typography.H2 style={{ textAlign: 'center' }} color={theme.colorText}>
          Let's set up your store
        </Typography.H2>

        <Gap $h={8} />

        <Typography.Body
          color={theme.colorTextSecondary}
          style={{ textAlign: 'center', maxWidth: 280 }}
        >
          Add a few details about your business and start selling in minutes.
        </Typography.Body>
      </Column>

      <Gap $h={24} />

      <Column
        style={{
          paddingHorizontal: theme.sizing.large,
          paddingBottom: theme.sizing.large,
        }}
      >
        <PillButton
          onPress={handleCreateStore}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Create your store"
        >
          <Typography.Body
            weight={600}
            color={theme.colorBgContainer}
            style={{ letterSpacing: 0.2 }}
          >
            Create your store
          </Typography.Body>

          <LucideIcon
            name="ArrowRight"
            size={18}
            color={theme.colorBgContainer}
          />
        </PillButton>
      </Column>
    </Root>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const Root = styled(SafeAreaView)`
  flex: 1;
  background-color: ${({ theme }) => theme.colorBgContainer};
`;

const Carousel = styled(ScrollView)`
  flex-grow: 0;
  height: ${CARD_HEIGHT + 56}px;
  background-color: transparent;
`;

const AnimatedCarousel = Animated.createAnimatedComponent(Carousel);

const Gap = styled.View<{ $h: number }>`
  height: ${({ $h }) => $h}px;
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