import type { Redis } from 'ioredis';
import type { ZodType } from 'zod';

/**
 * Read a Redis-cached JSON value and validate it against `schema` before
 * trusting it — instead of a blind `JSON.parse(x) as T`, which lets a schema
 * drift (a deploy that changes the cached shape while an old-TTL entry is
 * still live) reach the caller as a wrongly-shaped object with no runtime
 * signal. Mirrors the pattern CryptoService.verifyJwt already applies to
 * JWT claims.
 *
 * A parse/validation failure is treated as a cache miss (returns `null`),
 * so the caller's normal miss path (rebuild from the DB) recovers — same
 * contract a caller already has for a genuine miss.
 */
export async function readTypedCache<T>(
  redis: Redis,
  key: string,
  schema: ZodType<T>,
): Promise<T | null> {
  const raw = await redis.get(key);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}
