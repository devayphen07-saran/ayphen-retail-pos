import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Appearance, type ColorSchemeName, StatusBar } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ThemeProvider as StyledThemeProvider } from "styled-components/native";
import { mobileThemeTokens, type MobileTheme } from "./tokens";
import type { ColorVariantKey } from "./tokens/colors/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ThemePreference = "light" | "dark" | "auto";

export type ColorPlace = "background" | "main" | "border";

export interface MobileThemeContextType {
  /** Resolved mode after applying the user's preference and the OS scheme. */
  isDarkMode: boolean;
  /** Current OS color scheme. */
  colorScheme: ColorSchemeName;
  /** User preference: "light", "dark", or "auto". */
  themePreference: ThemePreference;
  /** True once the persisted preference has been read. */
  isThemeReady: boolean;
  /** Persist a preference and update the active theme. */
  setThemePreference: (preference: ThemePreference) => Promise<void>;
  /** Resolved theme tokens for the current mode. */
  theme: MobileTheme;
}

export interface MobileThemeProviderProps {
  children: ReactNode;
  loadingFallback?: ReactNode;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = "@ayphen_mobile_theme_preference";
const VALID_PREFERENCES: ReadonlyArray<ThemePreference> = ["light", "dark", "auto"];

function isValidPreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && VALID_PREFERENCES.includes(value as ThemePreference);
}

async function loadPreference(): Promise<ThemePreference> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (isValidPreference(raw)) return raw;
    return "auto";
  } catch (err) {
    if (__DEV__) console.warn("[MobileThemeProvider] Failed to load preference:", err);
    return "auto";
  }
}

async function savePreference(preference: ThemePreference): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, preference);
  } catch (err) {
    if (__DEV__) console.warn("[MobileThemeProvider] Failed to save preference:", err);
  }
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

function resolveIsDark(preference: ThemePreference, scheme: ColorSchemeName): boolean {
  if (preference === "dark") return true;
  if (preference === "light") return false;
  return scheme === "dark";
}

// ─── Context ──────────────────────────────────────────────────────────────────

const MobileThemeContext = createContext<MobileThemeContextType | undefined>(undefined);
MobileThemeContext.displayName = "AyphenMobileThemeContext";

// ─── Provider ─────────────────────────────────────────────────────────────────

export function MobileThemeProvider({
  children,
  loadingFallback = null,
}: MobileThemeProviderProps) {
  const [colorScheme, setColorScheme] = useState<ColorSchemeName>(
    Appearance.getColorScheme(),
  );
  const [themePreference, setPreferenceState] = useState<ThemePreference>("auto");
  const [isThemeReady, setIsThemeReady] = useState<boolean>(false);

  // Load persisted preference once on mount.
  useEffect(() => {
    let cancelled = false;
    loadPreference().then((preference) => {
      if (cancelled) return;
      setPreferenceState(preference);
      setIsThemeReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Track OS color scheme changes so "auto" stays in sync.
  useEffect(() => {
    const sub = Appearance.addChangeListener(({ colorScheme: next }) => {
      setColorScheme(next);
    });
    return () => sub.remove();
  }, []);

  const setThemePreference = useCallback(async (preference: ThemePreference) => {
    setPreferenceState(preference);
    await savePreference(preference);
  }, []);

  const isDarkMode = resolveIsDark(themePreference, colorScheme);

  const theme = useMemo<MobileTheme>(
    () => (isDarkMode ? mobileThemeTokens.dark : mobileThemeTokens.light),
    [isDarkMode],
  );

  const contextValue = useMemo<MobileThemeContextType>(
    () => ({
      isDarkMode,
      colorScheme,
      themePreference,
      isThemeReady,
      setThemePreference,
      theme,
    }),
    [isDarkMode, colorScheme, themePreference, isThemeReady, setThemePreference, theme],
  );

  return (
    <MobileThemeContext.Provider value={contextValue}>
      <StyledThemeProvider theme={theme}>
        <StatusBar
          barStyle={isDarkMode ? "light-content" : "dark-content"}
          backgroundColor={theme.colorBgLayout}
          translucent={false}
        />
        {isThemeReady ? children : loadingFallback}
      </StyledThemeProvider>
    </MobileThemeContext.Provider>
  );
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

export function useMobileTheme(): MobileThemeContextType {
  const ctx = useContext(MobileThemeContext);
  if (!ctx) {
    throw new Error("[useMobileTheme] Must be used inside <MobileThemeProvider>.");
  }
  return ctx;
}

export function useColorVariant({
  place,
}: {
  place: ColorPlace;
}): Record<ColorVariantKey, string> {
  const { theme } = useMobileTheme();

  return useMemo<Record<ColorVariantKey, string>>(() => {
    if (place === "background") {
      return {
        primary: theme.colorPrimaryBg,
        secondary: theme.colorFillSecondary ?? theme.colorBgContainer,
        danger: theme.colorErrorBg,
        success: theme.colorSuccessBg,
        warning: theme.colorWarningBg,
        orange: theme.amberBg,
        green: theme.greenBg,
        blue: theme.navyBg,
        violet: theme.violetBg,
        red: theme.redBg,
        grey: theme.colorGray ?? theme.colorTextSecondary ?? theme.colorBgContainer,
        default: theme.colorBgContainer,
      };
    }

    if (place === "border") {
      return {
        primary: theme.colorPrimaryBorder,
        secondary: theme.colorBorderSecondary ?? theme.colorBorder,
        danger: theme.colorErrorBorder,
        success: theme.colorSuccessBorder,
        warning: theme.colorWarningBorder,
        orange: theme.amber600,
        green: theme.green600,
        blue: theme.navy600,
        violet: theme.violet600,
        red: theme.red600,
        grey: theme.colorGray ?? theme.colorBorder,
        default: theme.colorBorder,
      };
    }

    return {
      primary: theme.colorPrimary,
      secondary: theme.colorTextSecondary ?? theme.colorText,
      danger: theme.colorError,
      success: theme.colorSuccess,
      warning: theme.colorWarning,
      orange: theme.colorAmber,
      green: theme.colorGreen,
      blue: theme.colorNavy,
      violet: theme.colorViolet,
      red: theme.colorRed,
      grey: theme.colorGray ?? theme.colorTextSecondary,
      default: theme.colorText,
    };
  }, [theme, place]);
}

export default MobileThemeProvider;
