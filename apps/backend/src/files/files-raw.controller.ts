import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { Public } from '#common/rbac/decorators/rbac.decorators.js';
import { LocalStorageProvider } from './storage/local-storage.provider.js';

/**
 * Signed raw-serve endpoint for the on-disk LocalStorageProvider (dev only).
 * Public because it's reached via a short-lived HMAC-signed URL that the
 * provider itself verifies — the same private-read guarantee an S3 presigned
 * GET gives. In production (S3 configured) the signed URL points at the bucket
 * and this route is never hit.
 *
 * Non-image content is served as an attachment and SVG never renders inline —
 * defence against a disguised-markup stored-XSS (Part C §C5).
 */
@Controller('files/raw')
export class FilesRawController {
  constructor(private readonly local: LocalStorageProvider) {}

  @Public()
  @Get(':key')
  async serve(
    @Param('key') key: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
  ): Promise<StreamableFile> {
    if (!this.local.verify(key, Number(exp), sig ?? '')) {
      throw new ForbiddenException('INVALID_OR_EXPIRED_SIGNATURE');
    }
    let buffer: Buffer;
    try {
      buffer = await this.local.readObject(key);
    } catch {
      throw new NotFoundException('FILE_NOT_FOUND');
    }
    const { type, inline } = contentTypeFor(key);
    return new StreamableFile(buffer, {
      type,
      disposition: inline ? 'inline' : 'attachment',
      length: buffer.length,
    });
  }
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
