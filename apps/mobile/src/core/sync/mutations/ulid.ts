import * as Crypto from 'expo-crypto';
import { factory, type PRNG } from 'ulid';

/**
 * `ulid`'s own auto-detected PRNG checks `window.crypto` (absent in React
 * Native), then falls back to `require('crypto')` expecting Node's `crypto`
 * module — Metro resolves that to something without `randomBytes`, crashing
 * with "nodeCrypto.randomBytes is not a function". Wiring a PRNG explicitly
 * (mirroring ulid's own browser-crypto branch, backed by expo-crypto instead
 * of a runtime-detected global) skips that broken path entirely.
 */
const prng: PRNG = () => {
  const buffer = new Uint8Array(1);
  Crypto.getRandomValues(buffer);
  return buffer[0] / 0xff;
};

/** Drop-in replacement for `ulid` package's default export — use this
 *  anywhere in the sync engine instead of importing `ulid` directly. */
export const ulid = factory(prng);
