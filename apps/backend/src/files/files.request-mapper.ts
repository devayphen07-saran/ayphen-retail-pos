import type { IncomingFile } from './file-validation.service.js';

/** Minimal shape of a multer memory-storage file (avoids a hard @types/multer dep). */
export interface MultipartFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * The inbound translation point for the multipart upload: multer's raw file →
 * the service's `IncomingFile` domain shape (§3.3). Pure, no DI, no async.
 */
export const FilesRequestMapper = {
  toIncomingFile(file: MultipartFile): IncomingFile {
    return {
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      buffer: file.buffer,
    };
  },
};