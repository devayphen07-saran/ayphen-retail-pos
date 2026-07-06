import type { Request } from 'express';

/**
 * Trusted client IP. With `trust proxy: 1` (set in apply-global-config),
 * Express derives `req.ip` from the proxy-appended X-Forwarded-For hop, which
 * a client cannot spoof — unlike the raw leftmost XFF entry. Used for the
 * custom per-IP rate limits and audit rows, so it MUST be spoof-resistant.
 */
export function getRequestIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? '0.0.0.0';
}
