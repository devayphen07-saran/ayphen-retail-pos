import React, { ReactNode } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Platform,
  ScrollViewProps,
  StyleSheet,
  View,
} from 'react-native';

import { AppLayout, AppLayoutProps } from './index';

interface AppScrollLayoutProps extends Omit<AppLayoutProps, 'children'> {
  children: ReactNode;
  scrollViewProps?: ScrollViewProps;
  /** Enables keyboard-avoiding behavior. Default: true. */
  avoidKeyboard?: boolean;
}

export function AppScrollLayout({
  children,
  scrollViewProps,
  avoidKeyboard = true,
  ...layoutProps
}: AppScrollLayoutProps) {
  const content = (
    <Animated.ScrollView
      {...scrollViewProps}
      style={styles.scrollView}
      contentContainerStyle={[styles.contentContainer, scrollViewProps?.contentContainerStyle]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      {children}
    </Animated.ScrollView>
  );

  return (
    <AppLayout {...layoutProps}>
      {avoidKeyboard ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.flex}
        >
          {content}
        </KeyboardAvoidingView>
      ) : (
        <View style={styles.flex}>{content}</View>
      )}
    </AppLayout>
  );
}

export default AppScrollLayout;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scrollView: { flex: 1 },
  contentContainer: { flexGrow: 1 },
});
