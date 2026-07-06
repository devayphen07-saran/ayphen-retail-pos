import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../error-codes';

/** Structured, non-sensitive context surfaced as `error.details` on the wire. */
type Details = Record<string, unknown>;

/**
 * The one domain exception the whole backend throws. It extends `HttpException`
 * so Nest routes it, but carries a machine-readable `errorCode` from the
 * `ErrorCodes` enum. The global `AllExceptionsFilter` is the only place that
 * turns this into an HTTP body.
 *
 * Prefer the status-typed subclasses below (`NotFoundError`, `ForbiddenError`,
 * …) so call sites don't repeat magic status numbers.
 */
export class AppException extends HttpException {
  constructor(
    public readonly errorCode: ErrorCode,
    message: string,
    statusCode: number = HttpStatus.BAD_REQUEST,
    public readonly details?: Details,
  ) {
    super({ message, errorCode, details }, statusCode);
  }
}

/** 400 — malformed or semantically invalid request. */
export class BadRequestError extends AppException {
  constructor(code: ErrorCode, message: string, details?: Details) {
    super(code, message, HttpStatus.BAD_REQUEST, details);
  }
}

/** 401 — authentication missing/invalid. */
export class UnauthorizedError extends AppException {
  constructor(code: ErrorCode, message = 'Authentication required', details?: Details) {
    super(code, message, HttpStatus.UNAUTHORIZED, details);
  }
}

/** 403 — authenticated but not allowed. */
export class ForbiddenError extends AppException {
  constructor(code: ErrorCode, message = 'Forbidden', details?: Details) {
    super(code, message, HttpStatus.FORBIDDEN, details);
  }
}

/** 402 — payment required (subscription lapsed). */
export class PaymentRequiredError extends AppException {
  constructor(code: ErrorCode, message = 'Payment required', details?: Details) {
    super(code, message, HttpStatus.PAYMENT_REQUIRED, details);
  }
}

/** 404 — resource not found. */
export class NotFoundError extends AppException {
  constructor(code: ErrorCode, message = 'Resource not found', details?: Details) {
    super(code, message, HttpStatus.NOT_FOUND, details);
  }
}

/** 409 — conflict (duplicate, concurrent modification). */
export class ConflictError extends AppException {
  constructor(code: ErrorCode, message = 'Conflict', details?: Details) {
    super(code, message, HttpStatus.CONFLICT, details);
  }
}

/** 410 — the resource is permanently gone (sync horizon / client too old). */
export class GoneError extends AppException {
  constructor(code: ErrorCode, message = 'Gone', details?: Details) {
    super(code, message, HttpStatus.GONE, details);
  }
}

/** 422 — well-formed but business-rule invalid. */
export class UnprocessableError extends AppException {
  constructor(code: ErrorCode, message = 'Unprocessable request', details?: Details) {
    super(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }
}

/** 429 — too many requests. */
export class RateLimitError extends AppException {
  constructor(code: ErrorCode = 'RATE_LIMIT_EXCEEDED', message = 'Too many requests', details?: Details) {
    super(code, message, HttpStatus.TOO_MANY_REQUESTS, details);
  }
}

/** 503 — a dependency (DB/Redis/payment provider) is unavailable. */
export class ServiceUnavailableError extends AppException {
  constructor(code: ErrorCode = 'SERVICE_UNAVAILABLE', message = 'Service temporarily unavailable', details?: Details) {
    super(code, message, HttpStatus.SERVICE_UNAVAILABLE, details);
  }
}
