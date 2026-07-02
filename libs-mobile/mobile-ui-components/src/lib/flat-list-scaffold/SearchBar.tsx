import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMobileTheme } from '@nks/mobile-theme';

import { LucideIcon, LucideIconNameType } from '../lucide-icon';

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
                <Text style={styles.badgeText}>{resolvedBadge}</Text>
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
              <Text
                style={[
                  styles.sheetTitle,
                  { color: theme.colorText, fontFamily: theme.fontFamily.poppinsSemiBold },
                ]}
              >
                {filterTitle}
              </Text>
            </View>

            {/* Options — scrollable so long lists never push past the notch */}
            <ScrollView
              bounces={false}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <SafeAreaView edges={['bottom']} style={{ paddingBottom: 16 }}>
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
                    <Text
                      style={[
                        styles.optionLabel,
                        {
                          color: filterValue === opt.key ? theme.colorPrimary : theme.colorText,
                          fontFamily:
                            filterValue === opt.key
                              ? theme.fontFamily.poppinsSemiBold
                              : theme.fontFamily.poppinsRegular,
                        },
                      ]}
                    >
                      {opt.label}
                    </Text>
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

const styles = StyleSheet.create({
  // ── search bar ──────────────────────────────────────────────────────────────
  wrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 8,
  },
  pill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'ios' ? 8 : 6,
    gap: 6,
  },
  input: {
    flex: 1,
    fontSize: 15,
    padding: 0,
    margin: 0,
  },
  actionBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: 4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 14,
  },
  // ── filter sheet ────────────────────────────────────────────────────────────
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.18)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: Dimensions.get('window').height * 0.6,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },
  handleZone: {
    alignItems: 'center',
    paddingTop: 12,
    paddingBottom: 8,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  sheetHeader: {
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetTitle: {
    fontSize: 17,
    textAlign: 'center',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 15,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optionLabel: {
    fontSize: 15,
  },
});
