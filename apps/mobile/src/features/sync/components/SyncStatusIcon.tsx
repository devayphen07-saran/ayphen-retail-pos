import { useEffect, useState } from 'react';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { router } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { IconButton, LucideIcon } from '@ayphen/mobile-ui-components';
import { requestImmediateSync } from '@core/sync/scheduler-instance';
import { usePendingSyncCount } from '../hooks/usePendingSyncCount';
import { useSyncIssueCount } from '../hooks/useSyncIssueCount';

/**
 * Header affordance, reusable across any screen's AppLayout `rightElement`.
 * Spins while local writes are queued waiting to reach the server
 * (usePendingSyncCount) OR while a manually-triggered cycle from THIS tap is
 * in flight (isManualSyncing) — the latter matters because tapping with an
 * empty queue still means "go check the server for updates," which wouldn't
 * otherwise move the icon at all. Turns error-colored when something needs
 * the user's attention (conflict/rejected/dead-lettered — useSyncIssueCount),
 * and sits static once everything's synced. Tapping opens Sync Issues when
 * there's a problem, otherwise actually calls `requestImmediateSync()` (a
 * real push+pull cycle, not just a visual nudge) and reflects it while it runs.
 */
export function SyncStatusIcon({ size = 36 }: { size?: number }) {
  const { theme } = useMobileTheme();
  const issueCount = useSyncIssueCount();
  const pending = usePendingSyncCount();
  const [isManualSyncing, setIsManualSyncing] = useState(false);

  const isSyncing = pending.total > 0 || isManualSyncing;

  const spin = useSharedValue(0);

  useEffect(() => {
    if (isSyncing) {
      spin.value = withRepeat(withTiming(360, { duration: 1200, easing: Easing.linear }), -1, false);
    } else {
      cancelAnimation(spin);
      spin.value = 0;
    }
  }, [isSyncing, spin]);

  const spinStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value}deg` }] }));

  const color = issueCount > 0 ? theme.colorError : isSyncing ? theme.colorPrimary : theme.colorTextTertiary;

  const label = issueCount > 0
    ? `${issueCount} sync issue${issueCount === 1 ? '' : 's'} — tap to review`
    : isManualSyncing
      ? 'Syncing…'
      : pending.total > 0
        ? `${pending.total} change${pending.total === 1 ? '' : 's'} waiting to sync`
        : 'All changes synced — tap to sync now';

  const handlePress = () => {
    if (issueCount > 0) {
      router.push('/(store)/sync-issues');
      return;
    }
    if (isManualSyncing) return; // already running one from this tap
    setIsManualSyncing(true);
    void requestImmediateSync().finally(() => setIsManualSyncing(false));
  };

  return (
    <IconButton
      variant="ghost"
      size={size}
      color={color}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={handlePress}
      iconElement={
        <Animated.View style={spinStyle}>
          <LucideIcon name="RefreshCw" size={Math.round(size * 0.55)} color={color} />
        </Animated.View>
      }
    />
  );
}