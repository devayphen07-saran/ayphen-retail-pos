/**
 * Device identity — an Ed25519 key pair that uniquely identifies this physical
 * device to the backend.
 *
 * - Private key: generated once, stored in the OS secure enclave (expo-secure-store),
 *   NEVER leaves the device.
 * - Public key: base64, sent at login/signup (the `device.public_key` field) so the
 *   server can record the device and, later, verify signed challenges.
 * - Signing: the device signs the refresh/step-up challenge string with its private
 *   key; the backend verifies with the stored public key (Ed25519, hex signature).
 *
 * Backend contract (verified in apps/backend/src/auth/core/crypto.service.ts):
 *   publicKey  → base64, imported raw (32 bytes)
 *   signature  → hex
 *   message    → the raw challenge string (UTF-8 bytes)
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

// @noble/ed25519 v3 needs SHA-512 injected before sign/verify. Wire it from
// noble/hashes. The cast bridges a benign ArrayBufferLike vs ArrayBuffer skew
// between the two noble packages' Uint8Array generics.
ed.hashes.sha512 = sha512 as unknown as typeof ed.hashes.sha512;

const PRIVATE_KEY_KEY = 'ayphen_pos_device_priv_key'; // hex-encoded 32-byte seed

// ── Encoding helpers ──────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  // btoa is available in the RN/Hermes runtime.
  return btoa(bin);
}

// ── Key lifecycle ─────────────────────────────────────────────────────────────

async function loadPrivateKey(): Promise<Uint8Array | null> {
  const hex = await SecureStore.getItemAsync(PRIVATE_KEY_KEY);
  return hex ? fromHex(hex) : null;
}

async function createPrivateKey(): Promise<Uint8Array> {
  // 32 bytes of OS-grade randomness → the Ed25519 seed.
  const seed = Crypto.getRandomBytes(32);
  await SecureStore.setItemAsync(PRIVATE_KEY_KEY, toHex(seed), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return seed;
}

/**
 * Return the device's base64 public key, generating and persisting the key pair
 * on first call. Idempotent — the same key survives across launches (and iOS
 * reinstalls where the keychain persists), giving a stable device identity.
 */
export async function getDevicePublicKey(): Promise<string> {
  let priv = await loadPrivateKey();
  if (!priv) priv = await createPrivateKey();
  // Sync API, not *Async: the async variants fall back to WebCrypto
  // (crypto.subtle), which Hermes/React Native doesn't provide. The sync path
  // uses the ed.hashes.sha512 we wired above and needs no polyfill.
  const pub = ed.getPublicKey(priv);
  return toBase64(pub);
}

/**
 * Sign a challenge string with the device private key. Returns a hex signature
 * matching the backend's `Buffer.from(signatureHex, 'hex')` verifier.
 * Throws if no key pair exists yet (call `getDevicePublicKey()` first, i.e. after
 * a successful login).
 */
export async function signChallenge(challenge: string): Promise<string> {
  const priv = await loadPrivateKey();
  if (!priv) {
    throw new Error('[deviceKey] No device key pair — sign before login?');
  }
  const msg = new TextEncoder().encode(challenge);
  // Sync API — see getDevicePublicKey() for why (no crypto.subtle in RN).
  const sig = ed.sign(msg, priv);
  return toHex(sig);
}

/** Wipe the device key pair (e.g. on a hard reset). Rare — normal logout keeps it. */
export async function clearDeviceKey(): Promise<void> {
  await SecureStore.deleteItemAsync(PRIVATE_KEY_KEY);
}
