import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { AppConfigService } from '#config/app-config.service.js';
import { BadRequestError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import type { PutObjectResult, StorageProvider } from './storage.provider.js';

/**
 * Dev/test object store — writes under `STORAGE_LOCAL_DIR` and serves reads
 * through the backend's own signed raw-serve route (`GET /files/raw/:key`).
 * Bound only when no `STORAGE_BUCKET` is configured. NOT for production:
 * per-container disk is ephemeral and vanishes on redeploy.
 *
 * The signed URL is an HMAC over `key|exp` with a server secret, so a leaked
 * link expires and can't be forged — the same private-read guarantee the S3
 * provider gets from a presigned GET.
 */
@Injectable()
export class LocalStorageProvider implements StorageProvider {
  private readonly log = new Logger(LocalStorageProvider.name);
  private readonly root: string;

  constructor(private readonly config: AppConfigService) {
    this.root = resolve(this.config.storageLocalDir);
    this.log.warn(
      `Object storage not configured — using on-disk LocalStorageProvider at ${this.root} (dev only).`,
    );
  }

  /** Resolve a storage key to an absolute path, refusing any path-traversal escape. */
  private pathFor(key: string): string {
    const target = resolve(join(this.root, key));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new BadRequestError(ErrorCodes.VALIDATION_FAILED, 'Invalid storage key');
    }
    return target;
  }

  private sign(key: string, exp: number): string {
    return createHmac('sha256', `storage:${this.config.jwtAccessSecret}`)
      .update(`${key}|${exp}`)
      .digest('hex');
  }

  /** Verify a raw-serve request (used by the controller's local-serve route). */
  verify(key: string, exp: number, sig: string): boolean {
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
    const expected = this.sign(key, exp);
    // Constant-time-ish compare via length + HMAC equality.
    return expected.length === sig.length && expected === sig;
  }

  async readObject(key: string): Promise<Buffer> {
    return fs.readFile(this.pathFor(key));
  }

  async putObject(key: string, body: Buffer, _contentType: string): Promise<PutObjectResult> {
    const path = this.pathFor(key);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, body);
    return { url: `file://${path}` };
  }

  async deleteObject(key: string): Promise<void> {
    await fs.rm(this.pathFor(key), { force: true });
  }

  async copyObject(fromKey: string, toKey: string): Promise<void> {
    const to = this.pathFor(toKey);
    await fs.mkdir(dirname(to), { recursive: true });
    await fs.copyFile(this.pathFor(fromKey), to);
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = this.sign(key, exp);
    const encoded = encodeURIComponent(key);
    return `${this.config.publicBaseUrl}/files/raw/${encoded}?exp=${exp}&sig=${sig}`;
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await fs.access(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }
}
