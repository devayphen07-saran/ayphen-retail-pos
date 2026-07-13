import {
  Controller,
  Get,
  Param,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { Public } from '#common/rbac/decorators/rbac.decorators.js';
import { FilesRawService } from './files-raw.service.js';

/**
 * Signed raw-serve endpoint for the on-disk LocalStorageProvider (dev only).
 * Public because it's reached via a short-lived HMAC-signed URL that the
 * provider itself verifies — the same private-read guarantee an S3 presigned
 * GET gives. In production (S3 configured) the signed URL points at the bucket
 * and this route is never hit.
 *
 * Thin by design: signature verification, storage read, and the safe
 * content-type/disposition decision all live in FilesRawService.
 */
@Controller('files/raw')
export class FilesRawController {
  constructor(private readonly raw: FilesRawService) {}

  @Public()
  @Get(':key')
  async serve(
    @Param('key') key: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
  ): Promise<StreamableFile> {
    const file = await this.raw.serve(key, Number(exp), sig ?? '');
    return new StreamableFile(file.buffer, {
      type: file.type,
      disposition: file.inline ? 'inline' : 'attachment',
      length: file.buffer.length,
    });
  }
}
