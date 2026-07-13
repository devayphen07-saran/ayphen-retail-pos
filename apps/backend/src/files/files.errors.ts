import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  AppException,
} from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { HttpStatus } from '@nestjs/common';

/**
 * Feature-local error constructors — thin wrappers over the shared
 * `AppException` subclasses so call sites read intent-first and every file
 * error carries a code from the central `ErrorCodes` registry.
 */

export class FileNotFoundError extends NotFoundError {
  constructor(details?: Record<string, unknown>) {
    super(ErrorCodes.FILE_NOT_FOUND, 'File not found', details);
  }
}

export class TempFileNotFoundError extends NotFoundError {
  constructor(details?: Record<string, unknown>) {
    super(ErrorCodes.TEMP_FILE_NOT_FOUND, 'Staged file not found or already committed', details);
  }
}

export class TempFileExpiredError extends BadRequestError {
  constructor(details?: Record<string, unknown>) {
    super(ErrorCodes.TEMP_FILE_EXPIRED, 'Staged file has expired — re-upload it', details);
  }
}

export class FileTypeNotAllowedError extends BadRequestError {
  constructor(extension: string, allowed: string[]) {
    super(ErrorCodes.FILE_TYPE_NOT_ALLOWED, `File type ".${extension}" is not allowed`, {
      extension,
      allowed,
    });
  }
}

export class FileTooLargeError extends BadRequestError {
  constructor(sizeBytes: number, maxBytes: number) {
    super(ErrorCodes.FILE_TOO_LARGE, 'File exceeds the maximum allowed size', {
      sizeBytes,
      maxBytes,
    });
  }
}

export class ConsolidatedSizeExceededError extends BadRequestError {
  constructor(details: Record<string, unknown>) {
    super(
      ErrorCodes.FILE_CONSOLIDATED_SIZE_EXCEEDED,
      'Attaching this file would exceed the total storage allowed for this record',
      details,
    );
  }
}

export class AttachmentLimitExceededError extends BadRequestError {
  constructor(max: number) {
    super(ErrorCodes.FILE_ATTACHMENT_LIMIT_EXCEEDED, `This record already has the maximum of ${max} attachments`, {
      max,
    });
  }
}

export class FileContentMismatchError extends BadRequestError {
  constructor(declared: string, detected: string | null) {
    super(
      ErrorCodes.FILE_CONTENT_MISMATCH,
      'File content does not match its declared type',
      { declared, detected },
    );
  }
}

export class EmptyFileError extends BadRequestError {
  constructor() {
    super(ErrorCodes.FILE_EMPTY, 'File is empty');
  }
}

export class FileConfigNotFoundError extends BadRequestError {
  constructor(entityType: string, kind: string | null) {
    super(ErrorCodes.FILE_CONFIG_NOT_FOUND, 'No upload rules configured for this entity/kind', {
      entityType,
      kind,
    });
  }
}

export class EntityDoesNotSupportAttachmentsError extends ForbiddenError {
  constructor(entityType: string) {
    super(
      ErrorCodes.ENTITY_DOES_NOT_SUPPORT_ATTACHMENTS,
      `Entity "${entityType}" does not support attachments`,
      { entityType },
    );
  }
}

/**
 * Commit was asked to link files to a parent record that does not exist (or was
 * deleted, or belongs to another store). Because the offline uploader defers
 * until the parent has synced, a live commit hitting this means the parent's
 * create was rejected/dead-lettered — the client maps this to `orphaned` and
 * cleans up. 409 (Conflict), not 404: the file object was staged fine; it's the
 * *linkage target* that's gone. (image-offline-architecture.md P1-12a.)
 */
export class ParentRecordNotFoundError extends ConflictError {
  constructor(entityType: string, recordGuuid: string) {
    super(ErrorCodes.FILE_PARENT_NOT_FOUND, 'The record to attach this file to no longer exists', {
      entityType,
      recordGuuid,
    });
  }
}

/**
 * Commit targeted an entity whose existence can't be verified — no record
 * resolver is registered for it (RecordExistenceService). Fail-closed: we never
 * create a `files` row we can't tie to a real parent. A misconfiguration signal,
 * not a client error.
 */
export class ParentVerificationUnavailableError extends AppException {
  constructor(entityType: string) {
    super(
      ErrorCodes.FILE_PARENT_VERIFICATION_UNAVAILABLE,
      `No record resolver registered for entity "${entityType}" — cannot verify the attachment's parent`,
      HttpStatus.INTERNAL_SERVER_ERROR,
      { entityType },
    );
  }
}

export class StorageUnavailableError extends AppException {
  constructor(message = 'File storage is temporarily unavailable') {
    super(ErrorCodes.STORAGE_UNAVAILABLE, message, HttpStatus.SERVICE_UNAVAILABLE);
  }
}
