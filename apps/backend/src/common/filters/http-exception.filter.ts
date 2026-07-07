import {
  Catch,
  ArgumentsHost,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { ThrottlerException } from '@nestjs/throttler';
import type postgres from 'postgres';
import { AppException } from '../exceptions/app.exception';
import { ErrorCodes } from '../error-codes';
import { unwrapPgError } from '../../db/rethrow-unique-violation';

/**
 * A bare SCREAMING_SNAKE_CASE code (e.g. what guards throw:
 * `throw new ForbiddenException('STORE_NOT_FOUND')`). No spaces, all
 * upper-snake — distinguishes a code-as-message from a human sentence.
 */
const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;

/** Human-readable fallback message from a SCREAMING_SNAKE code. */
function humanize(code: string): string {
  const s = code.toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** What every classify* method produces — the one shape catch() renders. */
interface Classified {
  status: number;
  errorCode: string;
  message: string;
  issues?: unknown[];
  details?: Record<string, unknown>;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx       = host.switchToHttp();
    const response  = ctx.getResponse<Response>();
    const request   = ctx.getRequest<Request>();
    const requestId = request.headers['x-request-id'] as string;

    const classified = this.classify(exception);

    response.status(classified.status).json({
      success:    false,
      statusCode: classified.status,
      message:    classified.message,
      data:       null,
      // §22: guards throw SCREAMING_SNAKE; the JSON body renders the snake_case
      // (lowercase) form of the same code.
      errorCode:  classified.errorCode.toLowerCase(),
      ...(classified.issues && { issues: classified.issues }),
      ...(classified.details && { details: classified.details }),
      requestId,
      timestamp:  new Date().toISOString(),
    });
  }

  private classify(exception: unknown): Classified {
    if (exception instanceof ThrottlerException) return this.classifyThrottler();
    if (exception instanceof AppException) return this.classifyAppException(exception);
    if (exception instanceof HttpException) return this.classifyHttpException(exception);

    const pgErr = unwrapPgError(exception);
    if (pgErr) return this.classifyPgError(pgErr);

    // 5. Unknown — log internally, never expose internals
    this.logger.error(
      'Unhandled exception',
      exception instanceof Error ? exception.stack : String(exception),
    );
    return {
      status:    HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: ErrorCodes.INTERNAL_ERROR,
      message:   'Internal server error',
    };
  }

  private classifyThrottler(): Classified {
    return {
      status:    HttpStatus.TOO_MANY_REQUESTS,
      errorCode: ErrorCodes.RATE_LIMIT_EXCEEDED,
      message:   'Too many requests — please slow down and try again later',
    };
  }

  /** 1. Domain errors thrown explicitly via throw new AppException(...) */
  private classifyAppException(exception: AppException): Classified {
    const raw = (exception.getResponse() as { message: string }).message;
    // Many call sites pass a SCREAMING_SNAKE code as the message
    // (e.g. new AppException(ErrorCodes.X, 'OTP_ALREADY_CONSUMED', 422)).
    // Humanize it so clients get prose, not a raw code — matching
    // classifyHttpException's guard-pattern branch below.
    return {
      status:    exception.getStatus(),
      errorCode: exception.errorCode,
      message:   SCREAMING_SNAKE.test(raw) ? humanize(raw) : raw,
      details:   exception.details,
    };
  }

  /** 2 & 3. NestJS built-in exceptions (guards, pipes, etc.) */
  private classifyHttpException(exception: HttpException): Classified {
    const status = exception.getStatus();
    const body = exception.getResponse();

    let errorCode: string = ErrorCodes.INTERNAL_ERROR;
    let message:   string = 'Internal server error';
    let issues:    unknown[] | undefined;
    let details:   Record<string, unknown> | undefined;

    if (typeof body === 'object' && body !== null) {
      const b = body as Record<string, unknown>;
      if (Array.isArray(b['message'])) {
        // Validation array body — from class-validator's ValidationPipe OR
        // from parse() (Zod). Both send message: string[] + VALIDATION_FAILED.
        message   = (b['message'] as string[]).join('; ');
        errorCode = ErrorCodes.VALIDATION_FAILED;
        // Preserve structured field-level detail when the thrower supplied it
        // (parse() attaches the raw Zod issue list).
        if (Array.isArray(b['issues'])) issues = b['issues'] as unknown[];
      } else if (typeof b['message'] === 'string') {
        const raw = b['message'];
        if (typeof b['errorCode'] === 'string') {
          message   = raw;
          errorCode = b['errorCode'];
        } else if (SCREAMING_SNAKE.test(raw)) {
          // Guard pattern: `throw new ForbiddenException('STORE_NOT_FOUND')`.
          // The code lands in `message`; promote it to errorCode (rbac.md §22)
          // and synthesise a human message so the code doesn't leak as prose.
          errorCode = raw;
          message   = humanize(raw);
        } else {
          message   = raw;
          errorCode = ErrorCodes.INTERNAL_ERROR;
        }
      }
      // Structured context alongside a guard-pattern code, e.g.
      // `throw new ForbiddenException({ message: 'STORE_LIMIT_REACHED', details: { limit, current } })`.
      if (b['details'] && typeof b['details'] === 'object') {
        details = b['details'] as Record<string, unknown>;
      }
    } else if (typeof body === 'string' && SCREAMING_SNAKE.test(body)) {
      errorCode = body;
      message   = humanize(body);
    } else {
      message = exception.message;
    }

    return { status, errorCode, message, issues, details };
  }

  /**
   * 4. postgres.js driver errors — map well-known PG codes to safe public
   * messages. Never expose constraint names, column names, or query text.
   * drizzle-orm wraps the real error in DrizzleQueryError, so unwrapPgError()
   * (called by classify()) looks at `.cause` too, not just the top-level type.
   */
  private classifyPgError(pgErr: postgres.PostgresError): Classified {
    switch (pgErr.code) {
      case '23505': // unique_violation
        return {
          status:    HttpStatus.CONFLICT,
          errorCode: ErrorCodes.DUPLICATE_ENTRY,
          message:   'A record with this value already exists',
        };
      case '23503': // foreign_key_violation
        return {
          status:    HttpStatus.BAD_REQUEST,
          errorCode: ErrorCodes.FOREIGN_KEY_VIOLATION,
          message:   'Referenced record does not exist',
        };
      case '23502': // not_null_violation
        return {
          status:    HttpStatus.BAD_REQUEST,
          errorCode: ErrorCodes.VALIDATION_FAILED,
          message:   'A required field is missing',
        };
      case '22P02': // invalid_text_representation (bad UUID, bad enum value)
        return {
          status:    HttpStatus.BAD_REQUEST,
          errorCode: ErrorCodes.VALIDATION_FAILED,
          message:   'Invalid ID format',
        };
      case '23514': // check_violation — schema CHECK constraints are a real
                     // invariant backstop here (users_email_or_phone, etc.),
                     // so a violation is a client-correctable 400, not a 500.
        return {
          status:    HttpStatus.BAD_REQUEST,
          errorCode: ErrorCodes.VALIDATION_FAILED,
          message:   'The request violates a data constraint',
        };
      default:
        this.logger.error(`Unhandled PostgresError ${pgErr.code}: ${pgErr.message}`);
        return {
          status:    HttpStatus.INTERNAL_SERVER_ERROR,
          errorCode: ErrorCodes.INTERNAL_ERROR,
          message:   'Internal server error',
        };
    }
  }
}
