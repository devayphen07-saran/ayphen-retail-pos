import { Alert as RNAlert, AlertButton, AlertOptions } from "react-native";

/**
 * Standardized Alert utility for NKS Mobile.
 * Wraps React Native's Alert.alert to provide a consistent and reusable API.
 */
export const Alert = {
  /**
   * Shows a native alert dialog.
   * @param title - The dialog title.
   * @param message - The dialog message body.
   * @param buttons - Array of button configurations (standard RN format).
   * @param options - Additional RN alert options.
   */
  show: (
    title: string,
    message?: string,
    buttons?: AlertButton[],
    options?: AlertOptions
  ) => {
    RNAlert.alert(title, message, buttons, options);
  },

  /**
   * Shows a simple information alert with a single "OK" button.
   */
  info: (title: string, message?: string, onOk?: () => void) => {
    RNAlert.alert(title, message, [{ text: "OK", onPress: onOk }]);
  },

  /**
   * Shows a confirmation alert with "Cancel" and a primary action button.
   */
  confirm: (
    title: string,
    message: string,
    onConfirm: () => void,
    confirmText = "Confirm",
    confirmStyle: "default" | "destructive" = "default"
  ) => {
    RNAlert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: confirmText, style: confirmStyle, onPress: onConfirm },
    ]);
  },
};
