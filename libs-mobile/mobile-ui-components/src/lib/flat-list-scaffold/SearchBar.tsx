import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMobileTheme, type MobileTheme } from '@ayphen/mobile-theme';

import { LucideIcon, LucideIconNameType } from '../lucide-icon';
import { Typography } from '../typography';

export interface FilterOption {
  key: string;
  label: string;
}

export interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;

  /** Custom right-side action button (use when NOT using filterOptions). */
  actionIcon?: LucideIconNameType;
  onAction?: () => void;
  actionLabel?: string;
  /** Badge count shown over the custom action icon. Hidden when 0 or undefined. */
  actionBadge?: number;

  /**
   * When provided, the filter icon + bottom sheet are managed internally.
   * The screen controls only filterValue / onFilterChange.
   * The first option is treated as the "default" (no badge shown).
   */
  filterOptions?: FilterOption[];
  filterValue?: string;
  onFilterChange?: (key: string) => void;
  filterTitle?: string;
}

export function SearchBar({
  value,
  onChangeText,
  placeholder = 'Search…',
  actionIcon,
  onAction,
  actionLabel,
  actionBadge,
  filterOptions,
  filterValue,
  onFilterChange,
  filterTitle = 'Filter',
}: SearchBarProps) {
  const { theme } = useMobileTheme();
  const screenHeight = Dimensions.get('window').height;
  const styles = useMemo(() => makeStyles(theme), [theme]);

  // ── filter sheet state ──────────────────────────────────────────────────────
  const [open, setOpen] = useState(false);
  const [showing, setShowing] = useState(false);
  const sheetAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (open) {
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
  }, [open, sheetAnim]);

  const translateY = sheetAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, screenHeight],
  });

  // ── resolved action props ───────────────────────────────────────────────────
  const isFilterMode = filterOptions != null && filterOptions.length > 0;
  const defaultFilterKey = isFilterMode ? filterOptions[0].key : undefined;
  const filterBadgeCount =
    isFilterMode && filterValue != null && filterValue !== defaultFilterKey ? 1 : 0;

  const resolvedActionIcon: LucideIconNameType | undefined = isFilterMode
    ? 'SlidersHorizontal'
    : actionIcon;
  const resolvedBadge = isFilterMode ? filterBadgeCount : (actionBadge ?? 0);
  const resolvedOnAction = isFilterMode ? () => setOpen(true) : onAction;
  const resolvedActionLabel = isFilterMode ? 'Filter' : actionLabel;

  return (
    <>
      {/* ── Search bar ─────────────────────────────────────────────────────── */}
      <View
        style={[
          styles.wrapper,
          {
            paddingHorizontal: theme.padding.xSmall,
            backgroundColor: theme.colorBgContainer,
          },
        ]}
      >
        <View style={[styles.pill, { backgroundColor: theme.colorBgLayout }]}>
          <LucideIcon name="Search" size={16} color={theme.colorTextSecondary} />

          <TextInput
            style={[styles.input, { color: theme.colorText }]}
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            placeholderTextColor={theme.colorTextSecondary}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            accessibilityLabel={placeholder}
          />

          {value.length > 0 && (
            <TouchableOpacity
              onPress={() => onChangeText('')}
              hitSlop={8}
              activeOpacity={0.7}
              accessibilityLabel="Clear search"
              accessibilityRole="button"
            >
              <LucideIcon name="XCircle" size={16} color={theme.colorTextSecondary} />
            </TouchableOpacity>
          )}
        </View>

        {resolvedActionIcon != null && resolvedOnAction != null && (
          <TouchableOpacity
            onPress={resolvedOnAction}
            activeOpacity={0.7}
            style={styles.actionBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={resolvedActionLabel}
          >
            <LucideIcon name={resolvedActionIcon} size={22} color={theme.colorPrimary} />
            {resolvedBadge > 0 && (
              <View style={[styles.badge, { backgroundColor: theme.colorPrimary }]}>
                <Typography.Caption
                  weight="bold"
                  color={theme.colorWhite}
                  style={{ fontSize: theme.fontSize.xxSmall }}
                >
                  {resolvedBadge}
                </Typography.Caption>
              </View>
            )}
          </TouchableOpacity>
        )}
      </View>

      {/* ── Filter sheet ───────────────────────────────────────────────────── */}
      {isFilterMode && (
        <Modal
          visible={showing}
          transparent
          animationType="none"
          onRequestClose={() => setOpen(false)}
        >
          {/* Backdrop — flex:1 fills the screen behind the sheet */}
          <Pressable style={styles.backdrop} onPress={() => setOpen(false)} />

          {/* Sheet — absolutely pinned to bottom, animated up */}
          <Animated.View
            style={[
              styles.sheet,
              { backgroundColor: theme.colorBgContainer },
              { transform: [{ translateY }] },
            ]}
          >
            {/* Handle bar */}
            <View style={styles.handleZone}>
              <View style={[styles.handle, { backgroundColor: theme.colorBorder }]} />
            </View>

            {/* Title */}
            <View style={[styles.sheetHeader, { borderBottomColor: theme.colorBorderSecondary }]}>
              <Typography.Subtitle
                weight="semiBold"
                color={theme.colorText}
                style={styles.sheetTitle}
              >
                {filterTitle}
              </Typography.Subtitle>
            </View>

            {/* Options — scrollable so long lists never push past the notch */}
            <ScrollView
              bounces={false}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <SafeAreaView edges={['bottom']} style={{ paddingBottom: theme.sizing.medium }}>
                {filterOptions.map((opt) => (
                  <TouchableOpacity
                    key={opt.key}
                    onPress={() => {
                      onFilterChange?.(opt.key);
                      setOpen(false);
                    }}
                    activeOpacity={0.7}
                    style={[styles.option, { borderBottomColor: theme.colorBorderSecondary }]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: filterValue === opt.key }}
                  >
                    <Typography.Body
                      weight={filterValue === opt.key ? 'semiBold' : 'normal'}
                      color={filterValue === opt.key ? theme.colorPrimary : theme.colorText}
                    >
                      {opt.label}
                    </Typography.Body>
                    {filterValue === opt.key && (
                      <LucideIcon name="Check" size={18} color={theme.colorPrimary} />
                    )}
                  </TouchableOpacity>
                ))}
              </SafeAreaView>
            </ScrollView>
          </Animated.View>
        </Modal>
      )}
    </>
  );
}

// StyleSheet holds layout-only entries (flex, alignment, position:0, %) plus
// value-bearing entries resolved from `theme.*` tokens. It's built per-theme via
// `makeStyles(theme)` (memoized in the component) since StyleSheet.create itself
// is static and cannot read the theme.
const makeStyles = (theme: MobileTheme) =>
  StyleSheet.create({
    // ── search bar ────────────────────────────────────────────────────────────
    wrapper: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: theme.sizing.xSmall, // 8
      gap: theme.sizing.xSmall, // 8
    },
    pill: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: theme.borderRadius.large, // 10
      paddingHorizontal: theme.sizing.xSmall, // 10 → 8 (tie 8/12, rounded down)
      paddingVertical: Platform.OS === 'ios' ? theme.sizing.xSmall : theme.sizing.xxSmall, // iOS 8 / Android 6 → 4 (tie 4/8)
      gap: theme.sizing.xxSmall, // 6 → 4 (tie 4/8, kept < wrapper gap)
    },
    input: {
      flex: 1,
      fontSize: theme.fontSize.regular, // 15 → 16 (tie 14/16; 16 avoids iOS focus-zoom)
      padding: 0,
      margin: 0,
    },
    actionBtn: {
      width: theme.sizing.xLarge, // 40 → 32 (tie 32/48; hitSlop keeps touch area)
      height: theme.sizing.xLarge, // 40 → 32
      alignItems: 'center',
      justifyContent: 'center',
    },
    badge: {
      position: 'absolute',
      top: theme.sizing.xxSmall, // 4
      right: theme.sizing.xxSmall, // 4
      minWidth: theme.sizing.medium, // 16
      height: theme.sizing.medium, // 16
      borderRadius: theme.borderRadius.regular, // 8
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: theme.sizing.xxSmall, // 3 → 4 (nearest)
    },
    // ── filter sheet ──────────────────────────────────────────────────────────
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.overlay.scrimSoft, // rgba(0,0,0,0.18) → scrimSoft (0.4); no 0.18 token
    },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: Dimensions.get('window').height * 0.6,
      borderTopLeftRadius: theme.borderRadius.xxLarge, // 18 → 14 (max non-pill radius)
      borderTopRightRadius: theme.borderRadius.xxLarge, // 18 → 14
    },
    handleZone: {
      alignItems: 'center',
      paddingTop: theme.sizing.small, // 12
      paddingBottom: theme.sizing.xSmall, // 8
    },
    handle: {
      width: theme.sizing.xLarge, // 36 → 32 (nearest)
      height: theme.sizing.xxSmall, // 4
      borderRadius: theme.borderRadius.xSmall, // 2
    },
    sheetHeader: {
      paddingHorizontal: theme.sizing.regular, // 20
      paddingBottom: theme.sizing.small, // 14 → 12 (tie 12/16, rounded down)
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    sheetTitle: {
      fontSize: theme.fontSize.medium, // 17
      textAlign: 'center',
    },
    option: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: theme.sizing.medium, // 15 → 16 (nearest)
      paddingHorizontal: theme.sizing.regular, // 20
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
  });
