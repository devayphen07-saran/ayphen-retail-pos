/**
 * Token storage — access + refresh tokens live ONLY in expo-secure-store
 * (Keychain/Keystore), never in memory-persisted state or SQLite
 * (api-and-state-management.md §12).
 */
import * as SecureStore from 'expo-secure-store';

const ACCESS_TOKEN_KEY = 'ayphen_pos_access_token';
const REFRESH_TOKEN_KEY = 'ayphen_pos_refresh_token';

// Bind tokens to THIS device and keep them out of encrypted iCloud/device
// backups (§7) — matches the device key's accessibility class (device-key.ts).
// A token restored onto another device is useless without the THIS_DEVICE_ONLY
// device key anyway, but backup-eligible tokens are an avoidable exposure.
const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
}

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function saveTokens(
  access: string,
  refresh: string,
): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_TOKEN_KEY, access, SECURE_OPTS),
    SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refresh, SECURE_OPTS),
  ]);
}

export async function saveAccessToken(access: string): Promise<void> {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, access, SECURE_OPTS);
}

export async function clearTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
  ]);
}
