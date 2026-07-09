import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MobileJwtGuard } from '#auth/mobile/guards/mobile-jwt.guard.js';
import { TenantGuard } from '#common/rbac/guards/tenant.guard.js';
import { SubscriptionStatusGuard } from '#auth/mobile/guards/subscription-status.guard.js';
import { StoreContext } from '#common/rbac/decorators/rbac.decorators.js';
import { parse } from '#common/validation/parse.js';
import { BadRequestError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { AppConfigService } from '#config/app-config.service.js';
import { FilesService } from './files.service.js';
import { CommitFilesDtoSchema } from './dto/commit-files.request.js';
import { CommitFilesRequestMapper } from './commit-files.request-mapper.js';
import {
  StageUploadFieldsSchema,
  ListFilesQuerySchema,
} from './dto/upload-fields.request.js';
import { FileTooLargeError } from './files.errors.js';
import type { TempUploadResponse } from './dto/temp-upload.response.js';
import type { FileResponse } from './dto/file.response.js';

/** Minimal shape of a multer memory-storage file (avoids a hard @types/multer dep). */
interface MultipartFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Two-phase file upload API (table-architecture §33, hardened to Part C).
 * Every route is store-scoped via `@StoreContext('param.storeId')` — TenantGuard
 * verifies the caller can access the store before the handler runs, and the
 * service scopes committed files by that store and staged temps by the caller
 * (owner). Per-parent-entity CRUD permission is a follow-up (files are
 * polymorphic, so the parent entity isn't known until request time).
 */
@Controller('stores/:storeId/files')
@UseGuards(MobileJwtGuard, TenantGuard, SubscriptionStatusGuard)
@StoreContext('param.storeId')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly config: AppConfigService,
  ) {}

  /** Phase 1 — stage an upload. Returns a guuid the client commits after saving the parent. */
  @Post('temp')
  @UseInterceptors(FileInterceptor('file'))
  async stage(
    @UploadedFile() file: MultipartFile | undefined,
    @Body() body: unknown,
  ): Promise<TempUploadResponse> {
    const { entity_type, kind } = parse(body, StageUploadFieldsSchema);
    if (!file)
      throw new BadRequestError(
        ErrorCodes.VALIDATION_FAILED,
        'A file is required',
      );
    if (file.size > this.config.uploadMaxFileSizeBytes) {
      throw new FileTooLargeError(
        file.size,
        this.config.uploadMaxFileSizeBytes,
      );
    }
    return this.files.stageUpload(
      {
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        buffer: file.buffer,
      },
      entity_type,
      kind,
    );
  }

  /** Cancel a staged upload before commit. */
  @Delete('temp/:guuid')
  @HttpCode(204)
  async cancelStaged(@Param('guuid') guuid: string): Promise<void> {
    await this.files.cancelStaged(guuid);
  }

  /** Phase 2 — commit staged temps into permanent, record-linked files. */
  @Post('commit')
  async commit(@Body() body: unknown): Promise<FileResponse[]> {
    const dto = parse(body, CommitFilesDtoSchema);
    return this.files.commit(CommitFilesRequestMapper.toCommand(dto));
  }

  /** List active files attached to a record. */
  @Get()
  async listByRecord(@Query() query: unknown): Promise<FileResponse[]> {
    const { entity_type, record_guuid } = parse(query, ListFilesQuerySchema);
    return this.files.listByRecord(entity_type, record_guuid);
  }

  /** A single file with a fresh presigned URL. */
  @Get(':guuid')
  async getFile(@Param('guuid') guuid: string): Promise<FileResponse> {
    return this.files.getFile(guuid);
  }

  /** Soft-delete (moves to trash; recoverable). */
  @Delete(':guuid')
  @HttpCode(204)
  async deleteFile(@Param('guuid') guuid: string): Promise<void> {
    await this.files.deleteFile(guuid);
  }

  /** Restore a soft-deleted file. */
  @Post(':guuid/restore')
  async restoreFile(@Param('guuid') guuid: string): Promise<FileResponse> {
    return this.files.restoreFile(guuid);
  }
}
