import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { Keyboard, Modal } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { BottomSheetShell } from "./BottomSheetShell";
import type { BottomSheetConfig, BottomSheetContextValue } from "./types";

const Ctx = createContext<BottomSheetContextValue | null>(null);

export function BottomSheetProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [config, setConfig] = useState<BottomSheetConfig | null>(null);
  const configRef = useRef<BottomSheetConfig | null>(null); // gestures read latest

  const open = useCallback(<P,>(cfg: BottomSheetConfig<P>) => {
    // A focused TextInput's keyboard is a system-level overlay — without
    // dismissing it first, it renders above the sheet's content even though
    // the sheet itself is now layered above it via the native Modal below.
    Keyboard.dismiss();
    configRef.current = cfg as BottomSheetConfig;
    setConfig(cfg as BottomSheetConfig);
    setVisible(true);
  }, []);

  const close = useCallback(() => {
    if (configRef.current?.preventClose) return; // locked → ignore
    setVisible(false); // onClose fires after anim (shell → runOnJS)
  }, []);

  const updateConfig = useCallback((partial: Partial<BottomSheetConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...partial } : prev));
    if (configRef.current) configRef.current = { ...configRef.current, ...partial };
  }, []);

  // The ONLY way to set preventClose. Guarantees unlock even if fn throws.
  const runLocked = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      updateConfig({ preventClose: true });
      try {
        return await fn();
      } finally {
        updateConfig({ preventClose: false });
      }
    },
    [updateConfig]
  );

  return (
    <Ctx.Provider value={{ open, close, updateConfig, runLocked, isOpen: visible }}>
      {children}
      {visible && config && (
        // A plain in-tree overlay renders within the app's normal layer, so a
        // focused input's keyboard (a system-level overlay) draws above it.
        // The native Modal gives the sheet its own window above the keyboard,
        // exactly like the RN Modal every sheet used before this shell existed.
        <Modal
          visible={visible}
          transparent
          animationType="none"
          statusBarTranslucent
          onRequestClose={close}
        >
          <GestureHandlerRootView style={{ flex: 1 }}>
            <BottomSheetShell
              config={config}
              configRef={configRef}
              onAnimatedClose={() => {
                setVisible(false);
                config.onClose?.();
              }}
            />
          </GestureHandlerRootView>
        </Modal>
      )}
    </Ctx.Provider>
  );
}

export function useBottomSheet() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useBottomSheet must be used inside BottomSheetProvider");
  return ctx;
}
