import { BadRequestError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';

/**
 * Opaque pagination cursor. Encodes the sort key of the last item on a page so
 * the next page can resume after it — stable under concurrent inserts/deletes,
 * unlike offset pagination.
 */
export interface Cursor {
  /** id of the last row on the page (tie-breaker). */
  id: string;
  /** sort value of the last row — an ISO timestamp string. */
  v:  string;
}

export function encodeCursor(id: string, v: string): string {
  return Buffer.from(JSON.stringify({ id, v })).toString('base64url');
}

export function decodeCursor(cursor: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Partial<Cursor>;
    if (typeof parsed.id !== 'string' || typeof parsed.v !== 'string') {
      throw new Error('malformed cursor');
    }
    return { id: parsed.id, v: parsed.v };
  } catch {
    throw new BadRequestError(ErrorCodes.INVALID_CURSOR, 'The pagination cursor is invalid');
  }
}
