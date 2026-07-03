/**
 * Build the `device` object sent on login/signup verify. Bundles the device's
 * public key with platform/version metadata the backend records.
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import type { DeviceRequest } from '@ayphen/api-manager';
import { getDevicePublicKey } from './device-key';

export async function buildDeviceRequest(
  pushToken?: string,
): Promise<DeviceRequest> {
  const publicKey = await getDevicePublicKey();
  return {
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    app_version: Constants.expoConfig?.version ?? '0.0.0',
    os_version: String(Platform.Version),
    model: Constants.deviceName ?? undefined,
    public_key: publicKey,
    push_token: pushToken,
  };
}
