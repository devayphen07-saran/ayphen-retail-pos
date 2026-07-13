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
import { env } from '#config/env.js';
import { parse } from '#common/validation/parse.js';
import { BadRequestError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { FilesService } from './files.service.js';
import { FilesMapper } from './files.mapper.js';
import {
  FilesRequestMapper,
  type MultipartFile,
} from './files.request-mapper.js';
import { CommitFilesDtoSchema } from './dto/commit-files.request.js';
import { CommitFilesRequestMapper } from './commit-files.request-mapper.js';
import {
  StageUploadFieldsSchema,
  ListFilesQuerySchema,
  ListFilesBatchQuerySchema,
} from './dto/upload-fields.request.js';
import type { TempUploadResponse } from './dto/temp-upload.response.js';
import type { FileResponse } from './dto/file.response.js';

/**
 * Two-phase file upload API (table-architecture §33, hardened to Part C).
 * Every route is store-scoped via `@StoreContext('param.storeId')` — TenantGuard
 * verifies the caller can access the store before the handler runs, and the
 * service scopes committed files by that store and staged temps by the caller
 * (owner). Per-parent-entity CRUD permission (D2) is enforced in FilesService:
 * every write (stage/commit/delete/restore) requires the parent entity's `edit`
 * grant, resolved at request time since files are polymorphic.
 */
@Controller('stores/:storeId/files')
@UseGuards(MobileJwtGuard, TenantGuard, SubscriptionStatusGuard)
@StoreContext('param.storeId')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /** Phase 1 — stage an upload. Returns a guuid the client commits after saving the parent. */
  @Post('temp')
  // Cap the multipart stream at the ingress so multer aborts mid-stream instead
  // of buffering an arbitrarily large body into memory (the Express json/urlencoded
  // limits don't apply to multipart/form-data). The handler still re-checks
  // file.size against the live config value below — this is the memory backstop.
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: env.UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024, files: 1 },
    }),
  )
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
    const staged = await this.files.stageUpload(
      FilesRequestMapper.toIncomingFile(file),
      entity_type,
      kind,
    );
    return FilesMapper.toTempResponse(staged);
  }

  /** Cancel a staged upload before commit. */
  @Delete('temp/:fileId')
  @HttpCode(204)
  async cancelStaged(@Param('fileId') fileId: string): Promise<void> {
    await this.files.cancelStaged(fileId);
  }

  /** Phase 2 — commit staged temps into permanent, record-linked files. */
  @Post('commit')
  async commit(@Body() body: unknown): Promise<FileResponse[]> {
    const dto = parse(body, CommitFilesDtoSchema);
    const views = await this.files.commit(
      CommitFilesRequestMapper.toCommand(dto),
    );
    return views.map((v) => FilesMapper.toFileResponse(v));
  }

  /** List active files attached to a record. */
  @Get()
  async listByRecord(@Query() query: unknown): Promise<FileResponse[]> {
    const { entity_type, record_guuid } = parse(query, ListFilesQuerySchema);
    const views = await this.files.listByRecord(entity_type, record_guuid);
    return views.map((v) => FilesMapper.toFileResponse(v));
  }

  /**
   * Batched grid read (P1-10): files for many records at once, keyed by
   * record_guuid. Declared before `:fileId` so "by-records" isn't captured as one.
   */
  @Get('by-records')
  async listByRecords(
    @Query() query: unknown,
  ): Promise<Record<string, FileResponse[]>> {
    const { entity_type, record_guuids } = parse(
      query,
      ListFilesBatchQuerySchema,
    );
    const grouped = await this.files.listByRecords(entity_type, record_guuids);
    return Object.fromEntries(
      Object.entries(grouped).map(([recordGuuid, views]) => [
        recordGuuid,
        views.map((v) => FilesMapper.toFileResponse(v)),
      ]),
    );
  }

  /** A single file with a fresh presigned URL. */
  @Get(':fileId')
  async getFile(@Param('fileId') fileId: string): Promise<FileResponse> {
    return FilesMapper.toFileResponse(await this.files.getFile(fileId));
  }

  /** Soft-delete (moves to trash; recoverable). */
  @Delete(':fileId')
  @HttpCode(204)
  async deleteFile(@Param('fileId') fileId: string): Promise<void> {
    await this.files.deleteFile(fileId);
  }

  /** Restore a soft-deleted file. */
  @Post(':fileId/restore')
  async restoreFile(@Param('fileId') fileId: string): Promise<FileResponse> {
    return FilesMapper.toFileResponse(await this.files.restoreFile(fileId));
  }
}
