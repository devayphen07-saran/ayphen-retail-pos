import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

// Accept a client-supplied trace id only if it's a safe, bounded token:
// alphanumerics, dash, underscore, up to 128 chars. This propagates a caller's
// existing trace id for cross-service correlation WITHOUT trusting it verbatim —
// arbitrary header content could carry newlines/control chars for log injection
// or be unboundedly large. Anything else is replaced with a fresh UUID.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const supplied = req.headers['x-request-id'];
    const requestId =
      typeof supplied === 'string' && SAFE_REQUEST_ID.test(supplied)
        ? supplied
        : randomUUID();
    req.headers['x-request-id'] = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  }
}
