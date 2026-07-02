import { useCallback, useEffect, useRef } from 'react';
import * as Haptics from 'expo-haptics';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import type { AVPlaybackSource } from 'expo-av';

export type ScanHapticSuccess = 'light' | 'medium' | 'heavy';
export type ScanHapticError = 'warning' | 'error' | 'success';

export interface ScanFeedbackOptions {
  successSound?: AVPlaybackSource | null;
  errorSound?: AVPlaybackSource | null;
  successHaptic?: ScanHapticSuccess | null;
  errorHaptic?: ScanHapticError | null;
  cooldownMs?: number;
}

const IMPACT_MAP: Record<ScanHapticSuccess, Haptics.ImpactFeedbackStyle> = {
  light:  Haptics.ImpactFeedbackStyle.Light,
  medium: Haptics.ImpactFeedbackStyle.Medium,
  heavy:  Haptics.ImpactFeedbackStyle.Heavy,
};

const NOTIFICATION_MAP: Record<ScanHapticError, Haptics.NotificationFeedbackType> = {
  warning: Haptics.NotificationFeedbackType.Warning,
  error:   Haptics.NotificationFeedbackType.Error,
  success: Haptics.NotificationFeedbackType.Success,
};

export function useScanFeedback(options: ScanFeedbackOptions = {}) {
  const {
    successSound  = null,
    errorSound    = null,
    successHaptic = 'heavy',
    errorHaptic   = 'error',
    cooldownMs    = 1500,
  } = options;

  const cooldown    = useRef(false);
  const lastScanned = useRef('');
  const successRef  = useRef<Audio.Sound | null>(null);
  const errorRef    = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      if (!successSound && !errorSound) {
        console.warn('[useScanFeedback] no sound sources provided');
        return;
      }

      if (__DEV__) console.log('[useScanFeedback] setting audio mode...');
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS:       true,
        allowsRecordingIOS:         false,
        staysActiveInBackground:    false,
        interruptionModeIOS:        InterruptionModeIOS.DuckOthers,
        interruptionModeAndroid:    InterruptionModeAndroid.DuckOthers,
        shouldDuckAndroid:          true,
        playThroughEarpieceAndroid: false,
      });
      if (__DEV__) console.log('[useScanFeedback] audio mode set');

      if (successSound) {
        if (__DEV__) console.log('[useScanFeedback] loading success sound...');
        const { sound } = await Audio.Sound.createAsync(successSound, {
          shouldPlay: false,
          volume:     1,
        });
        if (active) {
          successRef.current = sound;
          if (__DEV__) console.log('[useScanFeedback] success sound ready');
        } else {
          void sound.unloadAsync();
        }
      }

      if (errorSound) {
        if (__DEV__) console.log('[useScanFeedback] loading error sound...');
        const { sound } = await Audio.Sound.createAsync(errorSound, {
          shouldPlay: false,
          volume:     1,
        });
        if (active) {
          errorRef.current = sound;
          if (__DEV__) console.log('[useScanFeedback] error sound ready');
        } else {
          void sound.unloadAsync();
        }
      }
    }

    load().catch((e) => console.warn('[useScanFeedback] load failed:', e));

    return () => {
      active = false;
      void successRef.current?.unloadAsync();
      void errorRef.current?.unloadAsync();
      successRef.current = null;
      errorRef.current   = null;
    };
  }, [successSound, errorSound]);

  const playSound = useCallback(async (success: boolean): Promise<void> => {
    const label = success ? 'success' : 'error';
    try {
      const sound = success ? successRef.current : errorRef.current;
      if (!sound) {
        if (__DEV__) console.warn(`[useScanFeedback] ${label} sound not loaded — skipping`);
        return;
      }
      await sound.replayAsync({});
    } catch (e) {
      console.warn(`[useScanFeedback] replayAsync(${label}) failed:`, e);
    }
  }, []);

  const triggerFeedback = useCallback(
    (success: boolean): void => {
      void playSound(success);
      if (success && successHaptic) {
        Haptics.impactAsync(IMPACT_MAP[successHaptic]).catch(() => {});
      } else if (!success && errorHaptic) {
        Haptics.notificationAsync(NOTIFICATION_MAP[errorHaptic]).catch(() => {});
      }
    },
    [playSound, successHaptic, errorHaptic],
  );

  const shouldProcessScan = useCallback(
    (barcode: string): boolean => {
      if (cooldown.current) return false;
      if (barcode === lastScanned.current) return false;
      cooldown.current    = true;
      lastScanned.current = barcode;
      setTimeout(() => {
        cooldown.current    = false;
        lastScanned.current = '';
      }, cooldownMs);
      return true;
    },
    [cooldownMs],
  );

  return { triggerFeedback, shouldProcessScan };
}
