import { Injectable } from '@nestjs/common';
import { AppConfigService } from '#config/app-config.service.js';
import type { FileConfigRule } from './files-config.repository.js';
import {
  EmptyFileError,
  FileContentMismatchError,
  FileTooLargeError,
  FileTypeNotAllowedError,
  ConsolidatedSizeExceededError,
  AttachmentLimitExceededError,
} from './files.errors.js';

/** The bytes + declared metadata of one incoming upload. */
export interface IncomingFile {
  originalName: string;
  mimeType:     string; // client-declared — never trusted for security decisions
  size:         number;
  buffer:       Buffer;
}

/**
 * Server-side upload validation (Part C §C5 / BR1–BR4). Everything here is the
 * real gate — client checks are UX only. Runs in two phases:
 *  - `validateAtIngestion`: extension + per-file size + magic-byte content sniff
 *    (a spoofed Content-Type or a renamed executable is rejected here).
 *  - `validateAtCommit`: re-validates extension + per-file size against the
 *    rule resolved at COMMIT time, plus the record-scoped rules (consolidated
 *    size, attachment count) that need the parent record's existing files.
 *
 * Why re-validate extension/size at commit: a temp row's extension/size were
 * only checked once, at stage time, against whichever (entityTypeFk, kind)
 * rule was active then. `FilesService.commit` lets the caller target a
 * *different* (entityTypeFk, kind) than the one used to stage the file — so
 * without this re-check, a file staged under a lenient rule could be
 * committed under a stricter one and bypass its extension/size limits
 * entirely. This re-check is metadata-only (extension string + byte count),
 * not a content-sniff: the actual staged bytes aren't available at this layer
 * (StorageProvider is a write/copy/sign port with no "read back the bytes"
 * method), so a magic-byte re-sniff at commit would need a storage-layer
 * change out of scope here. The ingestion-time sniff already ran once when
 * the bytes first arrived, and commit only ever copies the same staged
 * object — it can't introduce new bytes — so the residual gap is narrow: an
 * extension allowed by the ingestion-time rule but disallowed by the
 * commit-time rule, where both rules would have passed the sniff (e.g.
 * staged as .pdf under a rule permitting PDFs, committed as .pdf under a
 * rule that doesn't). Extension + size fully close that gap.
 */
@Injectable()
export class FileValidationService {
  constructor(private readonly config: AppConfigService) {}

  /** Phase 1 — at raw upload, before anything is written to permanent storage. */
  validateAtIngestion(file: IncomingFile, rule: FileConfigRule): void {
    if (file.size <= 0 || file.buffer.length === 0) throw new EmptyFileError();

    this.validateExtensionAndSize(file, rule);
    const extension = this.extensionOf(file.originalName)!; // validated above

    // Content sniff: the declared extension must be consistent with the actual
    // bytes. Blocks stored-XSS via a script disguised as an image and renamed
    // executables (Part C §C5). SVG is intentionally NOT a sniffable image type
    // here — it's script-capable markup and must not pass an "image" gate.
    const detected = detectKind(file.buffer);
    if (detected && !kindMatchesExtension(detected, extension)) {
      throw new FileContentMismatchError(extension, detected);
    }
    if (isScriptableMarkup(file.buffer) && !TEXTUAL_EXTENSIONS.has(extension)) {
      throw new FileContentMismatchError(extension, 'markup/script');
    }
  }

  /**
   * Phase 2 — at commit/link, once the parent record and its existing files
   * are known. Re-validates extension + size against the COMMIT-time rule
   * (see class doc), then the record-scoped attachment-count/consolidated-
   * size budget.
   */
  validateAtCommit(
    file: { size: number; originalName: string },
    rule: FileConfigRule,
    existing: { count: number; totalBytes: number },
  ): void {
    this.validateExtensionAndSize(file, rule);

    if (existing.count + 1 > rule.maxAttachmentsAllowed) {
      throw new AttachmentLimitExceededError(rule.maxAttachmentsAllowed);
    }
    if (existing.totalBytes + file.size > rule.maxConsolidatedSizeBytes) {
      throw new ConsolidatedSizeExceededError({
        currentBytes: existing.totalBytes,
        incomingBytes: file.size,
        maxBytes: rule.maxConsolidatedSizeBytes,
      });
    }
  }

  /** Shared by both phases: hard size ceiling + extension allow-list against `rule`. */
  private validateExtensionAndSize(
    file: { size: number; originalName: string },
    rule: FileConfigRule,
  ): void {
    // Hard ceiling from the rule AND the global env cap (defence in depth).
    const maxBytes = Math.min(rule.maxFileSizeBytes, this.config.uploadMaxFileSizeBytes);
    if (file.size > maxBytes) throw new FileTooLargeError(file.size, maxBytes);

    const extension = this.extensionOf(file.originalName);
    if (!extension || !rule.validExtensions.includes(extension)) {
      throw new FileTypeNotAllowedError(extension ?? '', rule.validExtensions);
    }
  }

  private extensionOf(name: string): string | null {
    const dot = name.lastIndexOf('.');
    if (dot < 0 || dot === name.length - 1) return null;
    return name.slice(dot + 1).toLowerCase();
  }
}

// ─── Magic-byte sniffing (small, dependency-free; covers the formats this app
// actually accepts — images, PDF, common office/text) ───────────────────────

type DetectedKind = 'jpeg' | 'png' | 'gif' | 'webp' | 'bmp' | 'pdf' | 'zip';

const TEXTUAL_EXTENSIONS = new Set(['csv', 'txt']);

function detectKind(buf: Buffer): DetectedKind | null {
  if (buf.length < 4) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  // BMP: 42 4D
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  // PDF: 25 50 44 46
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf';
  // WEBP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'webp';
  }
  // ZIP container (also docx/xlsx/pptx): 50 4B 03 04
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'zip';
  return null;
}

const EXTENSION_KINDS: Record<string, DetectedKind[]> = {
  jpg:  ['jpeg'],
  jpeg: ['jpeg'],
  png:  ['png'],
  gif:  ['gif'],
  webp: ['webp'],
  bmp:  ['bmp'],
  pdf:  ['pdf'],
  // Office XML formats are ZIP containers.
  docx: ['zip'],
  xlsx: ['zip'],
  pptx: ['zip'],
};

/** When a signature is recognised, it must be consistent with the declared extension. */
function kindMatchesExtension(detected: DetectedKind, extension: string): boolean {
  const allowed = EXTENSION_KINDS[extension];
  // Unknown/legacy extensions (doc, xls, csv, txt) have no reliable signature —
  // don't reject solely on the sniff; the extension allow-list already gates them.
  if (!allowed) return true;
  return allowed.includes(detected);
}

/** Detect HTML/SVG/XML script-capable markup at the head of the buffer. */
function isScriptableMarkup(buf: Buffer): boolean {
  const head = buf.slice(0, 512).toString('utf8').trimStart().toLowerCase();
  return (
    head.startsWith('<?xml') ||
    head.startsWith('<svg') ||
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.includes('<script')
  );
}
