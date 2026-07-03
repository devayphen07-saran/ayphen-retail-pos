/**
 * Locally-remembered "last opened store" — device-side only (mobile-03 §4,
 * step 4b: `PATCH /me/preferences {last_opened_store_id}`). The backend
 * doesn't persist this yet, so it's kept here instead; not sensitive, so
 * AsyncStorage (not SecureStore) is the right tier.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthStore } from '../auth/authStore';

const LAST_OPENED_STORE_KEY = 'ayphen_pos_last_opened_store_id';

export async function getLastOpenedStoreId(): Promise<string | null> {
  return AsyncStorage.getItem(LAST_OPENED_STORE_KEY);
}

// Write-through: every write also updates authStore's in-memory cache, so
// AppGate/RootNavigator never need their own separate AsyncStorage read to
// see a fresh value — see authStore.ts's `lastOpenedStoreId` doc comment.
export async function setLastOpenedStoreId(storeId: string): Promise<void> {
  await AsyncStorage.setItem(LAST_OPENED_STORE_KEY, storeId);
  useAuthStore.getState().cacheLastOpenedStoreId(storeId);
}

export async function clearLastOpenedStoreId(): Promise<void> {
  await AsyncStorage.removeItem(LAST_OPENED_STORE_KEY);
  useAuthStore.getState().cacheLastOpenedStoreId(null);
}
