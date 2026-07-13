import { Injectable } from '@nestjs/common';
import { ForbiddenError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { FileNotFoundError } from './files.errors.js';
import { LocalStorageProvider } from './storage/local-storage.provider.js';

/** A raw object resolved for serving: bytes + how the client should render them. */
export interface RawFile {
  buffer: Buffer;
  type: string;
  /** Serve inline (known-safe rendered types) vs. force download (everything else). */
  inline: boolean;
}

const INLINE_IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
};

function contentTypeFor(key: string): { type: string; inline: boolean } {
  const dot = key.lastIndexOf('.');
  const ext = dot >= 0 ? key.slice(dot + 1).toLowerCase() : '';
  const type = INLINE_IMAGE_TYPES[ext];
  // Only known-safe rendered types are served inline; everything else (incl. any
  // markup/SVG) downloads as an attachment so it can't execute in the app origin.
  return type ? { type, inline: true } : { type: 'application/octet-stream', inline: false };
}

/**
 * Business logic for the dev-only signed raw-serve endpoint: verify the
 * short-lived HMAC signature, read the object off the LocalStorageProvider, and
 * decide the safe content-type/disposition. Keeps FilesRawController thin (§3.4)
 * — the controller only wraps the result in a StreamableFile.
 */
@Injectable()
export class FilesRawService {
  constructor(private readonly local: LocalStorageProvider) {}

  async serve(key: string, exp: number, sig: string): Promise<RawFile> {
    if (!this.local.verify(key, exp, sig)) {
      throw new ForbiddenError(ErrorCodes.FORBIDDEN, 'Invalid or expired signature');
    }
    let buffer: Buffer;
    try {
      buffer = await this.local.readObject(key);
    } catch {
      throw new FileNotFoundError();
    }
    const { type, inline } = contentTypeFor(key);
    return { buffer, type, inline };
  }
}
