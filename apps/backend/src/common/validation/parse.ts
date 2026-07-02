import { UnprocessableEntityException } from '@nestjs/common';
import type { ZodType, ZodIssue } from 'zod';
import { ErrorCodes } from '../error-codes';

/**
 * Render a Zod issue as a `field: reason` string. Falls back to the bare
 * message when the issue has no path (root-level errors).
 */
function formatIssue(issue: ZodIssue): string {
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Validate a request body against a Zod schema, returning the typed DTO.
 *
 * On failure throws `UnprocessableEntityException` (HTTP 422) with a body the
 * global `AllExceptionsFilter` understands: a `message` **array** (one entry
 * per field error) plus an explicit `errorCode`. This mirrors the shape the
 * class-validator `ValidationPipe` produces, so both validation paths render
 * identically and field-level detail is preserved (never collapses to a
 * generic 500-shaped body).
 *
 * The inferred `z.infer<>` type is the only request shape callers should
 * trust; never hand-cast a body with `as`.
 */
export function parse<T>(body: unknown, schema: ZodType<T>): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new UnprocessableEntityException({
      message:   result.error.issues.map(formatIssue),
      errorCode: ErrorCodes.VALIDATION_FAILED,
      issues:    result.error.issues,
    });
  }
  return result.data;
}
