import { Injectable, PipeTransform } from '@nestjs/common';

/**
 * Bound recursion so a hostile deeply nested payload cannot overflow the stack.
 * Values below this depth are cleaned normally; values at/after it pass through.
 */
const MAX_DEPTH = 8;

/**
 * Plain JSON object only (`{}` / `Object.create(null)`).
 * Buffers, Dates, streams, files, class instances, etc. must pass through as-is.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;

  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Trims string inputs and collapses blank/whitespace-only strings to `null`.
 *
 * This pipe:
 * - never mutates the original request body
 * - descends only into arrays and plain JSON objects
 * - leaves Buffers/Dates/files/class instances untouched
 * - is safe against cyclic objects
 * - avoids prototype-pollution edge cases by rebuilding objects with null prototype
 */
@Injectable()
export class TrimStringPipe implements PipeTransform {
  transform(value: unknown): unknown {
    return this.clean(value, 0, new WeakMap<object, unknown>());
  }

  private clean(
    value: unknown,
    depth: number,
    seen: WeakMap<object, unknown>,
  ): unknown {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    }

    if (value === null || typeof value !== 'object') {
      return value;
    }

    if (depth >= MAX_DEPTH) {
      return value;
    }

    const cached = seen.get(value);
    if (cached !== undefined) {
      return cached;
    }

    if (Array.isArray(value)) {
      const out: unknown[] = [];
      seen.set(value, out);

      for (const item of value) {
        out.push(this.clean(item, depth + 1, seen));
      }

      return out;
    }

    if (!isPlainObject(value)) {
      return value;
    }

    const out: Record<string, unknown> = Object.create(null);
    seen.set(value, out);

    for (const [key, item] of Object.entries(value)) {
      out[key] = this.clean(item, depth + 1, seen);
    }

    return out;
  }
}
