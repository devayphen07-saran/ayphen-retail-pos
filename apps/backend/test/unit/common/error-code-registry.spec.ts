import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorCodes } from '../../../src/common/error-codes';

/**
 * Static-analysis guard for the "guard pattern" (rbac.md §22):
 * `throw new ForbiddenException('STORE_NOT_FOUND')`. AllExceptionsFilter
 * promotes any SCREAMING_SNAKE-shaped exception message to `errorCode` with
 * no membership check against ErrorCodes (http-exception.filter.ts) — so a
 * typo'd code compiles, ships, and the mobile client can't recognize it.
 * AppException (and its NotFoundError/ForbiddenError/... subclasses) already
 * type their `code` param as `ErrorCode`, so those call sites are compiler-
 * enforced and excluded here; this only covers Nest's built-in
 * `*Exception` classes, which accept any string.
 */

const SRC_ROOT = join(__dirname, '../../../src');

const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

// Matches `new XxxException('CODE'` / `new XxxException("CODE"`, capturing
// the class name and the literal. AppException itself is excluded below —
// its first constructor param is the typed `ErrorCode`, not a bare message.
const THROW_PATTERN = /new\s+(\w*Exception)\(\s*['"]([^'"]+)['"]/g;

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      listTsFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('error-code registry enforcement', () => {
  it('every SCREAMING_SNAKE code thrown via a bare Nest exception is registered in ErrorCodes', () => {
    const knownCodes = new Set<string>(Object.values(ErrorCodes));
    const offenders: string[] = [];

    for (const file of listTsFiles(SRC_ROOT)) {
      // The registry itself and AllExceptionsFilter's own SCREAMING_SNAKE
      // regex/example-in-comment text aren't call sites.
      if (file.endsWith('/common/error-codes.ts')) continue;

      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(THROW_PATTERN)) {
        const [, className, code] = match;
        if (className === 'AppException') continue; // compiler-enforced already
        if (!SCREAMING_SNAKE.test(code)) continue; // a human sentence, not a code
        if (!knownCodes.has(code)) {
          offenders.push(`${file.slice(SRC_ROOT.length)}: new ${className}('${code}')`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
