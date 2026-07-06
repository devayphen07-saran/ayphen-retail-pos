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
import postgres from 'postgres';
import { AppException } from '../exceptions/app.exception';
import { ErrorCodes } from '../error-codes';

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

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx       = host.switchToHttp();
    const response  = ctx.getResponse<Response>();
    const request   = ctx.getRequest<Request>();
    const requestId = request.headers['x-request-id'] as string;

    let status:    number = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode: string = ErrorCodes.INTERNAL_ERROR;
    let message:   string = 'Internal server error';
    let issues:    unknown[] | undefined;
    let details:   Record<string, unknown> | undefined;

    if (exception instanceof ThrottlerException) {
      status    = HttpStatus.TOO_MANY_REQUESTS;
      errorCode = ErrorCodes.RATE_LIMIT_EXCEEDED;
      message   = 'Too many requests — please slow down and try again later';

    } else if (exception instanceof AppException) {
      // 1. Domain errors thrown explicitly via throw new AppException(...)
      status    = exception.getStatus();
      errorCode = exception.errorCode;
      const raw = (exception.getResponse() as { message: string }).message;
      // Many call sites pass a SCREAMING_SNAKE code as the message
      // (e.g. new AppException(ErrorCodes.X, 'OTP_ALREADY_CONSUMED', 422)).
      // Humanize it so clients get prose, not a raw code — matching the
      // bare-HttpException branch below.
      message   = SCREAMING_SNAKE.test(raw) ? humanize(raw) : raw;
      details   = exception.details;

    } else if (exception instanceof HttpException) {
      // 2 & 3. NestJS built-in exceptions (guards, pipes, etc.)
      status = exception.getStatus();
      const body = exception.getResponse();

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

    } else if (exception instanceof postgres.PostgresError) {
      // 4. postgres.js driver errors — map well-known PG codes to safe public messages.
      //    Never expose constraint names, column names, or query text.
      switch (exception.code) {
        case '23505': // unique_violation
          status    = HttpStatus.CONFLICT;
          errorCode = ErrorCodes.DUPLICATE_ENTRY;
          message   = 'A record with this value already exists';
          break;
        case '23503': // foreign_key_violation
          status    = HttpStatus.BAD_REQUEST;
          errorCode = ErrorCodes.FOREIGN_KEY_VIOLATION;
          message   = 'Referenced record does not exist';
          break;
        case '23502': // not_null_violation
          status    = HttpStatus.BAD_REQUEST;
          errorCode = ErrorCodes.VALIDATION_FAILED;
          message   = 'A required field is missing';
          break;
        case '22P02': // invalid_text_representation (bad UUID, bad enum value)
          status    = HttpStatus.BAD_REQUEST;
          errorCode = ErrorCodes.VALIDATION_FAILED;
          message   = 'Invalid ID format';
          break;
        default:
          this.logger.error(
            `Unhandled PostgresError ${exception.code}: ${exception.message}`,
          );
      }

    } else {
      // 5. Unknown — log internally, never expose internals
      this.logger.error(
        'Unhandled exception',
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      success:    false,
      statusCode: status,
      message,
      data:       null,
      // §22: guards throw SCREAMING_SNAKE; the JSON body renders the snake_case
      // (lowercase) form of the same code.
      errorCode:  errorCode.toLowerCase(),
      ...(issues && { issues }),
      ...(details && { details }),
      requestId,
      timestamp:  new Date().toISOString(),
    });
  }
}
