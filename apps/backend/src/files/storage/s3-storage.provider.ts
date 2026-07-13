import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '#config/app-config.service.js';
import { StorageUnavailableError } from '../files.errors.js';
import type { PutObjectResult, StorageProvider } from './storage.provider.js';

/**
 * S3-compatible object store (AWS S3 / Cloudflare R2 / MinIO). Bound only when
 * `STORAGE_BUCKET` is configured.
 *
 * The `@aws-sdk/*` packages are loaded lazily through a runtime dynamic import
 * so the app builds and boots with zero new dependencies when the on-disk
 * LocalStorageProvider is used instead. If S3 is selected but the SDK isn't
 * installed, the first call fails loudly with an actionable message rather than
 * at module load.
 */
@Injectable()
export class S3StorageProvider implements StorageProvider {
  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly bucket: string;
  private clientPromise?: Promise<{ client: S3Client; sdk: S3Sdk }>;

  constructor(private readonly config: AppConfigService) {
    this.bucket = this.config.storageBucket;
  }

  /** Lazily construct the S3 client + capture the SDK's command classes. */
  private async lazy(): Promise<{ client: S3Client; sdk: S3Sdk }> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        let clientMod: S3ClientModule;
        let presignerMod: S3PresignerModule;
        try {
          // Non-literal specifiers: TS treats these as `any` and skips static
          // resolution, so the build doesn't require the packages to be present.
          // `webpackIgnore` leaves the import() untouched in the bundle — without
          // it webpack rewrites a variable import() into a context module that
          // can't resolve the SDK at runtime (it always throws → 503). With it,
          // Node resolves the package from node_modules at first use.
          const clientSpec = '@aws-sdk/client-s3';
          const presignerSpec = '@aws-sdk/s3-request-presigner';
          clientMod = (await import(/* webpackIgnore: true */ clientSpec)) as S3ClientModule;
          presignerMod = (await import(/* webpackIgnore: true */ presignerSpec)) as S3PresignerModule;
        } catch {
          throw new StorageUnavailableError(
            'S3 storage is configured (STORAGE_BUCKET set) but the AWS SDK is not installed. ' +
              'Run: pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner',
          );
        }
        const client = new clientMod.S3Client({
          region: this.config.storageRegion,
          ...(this.config.storageEndpoint ? { endpoint: this.config.storageEndpoint } : {}),
          forcePathStyle: this.config.storageForcePathStyle,
          ...(this.config.storageAccessKeyId && this.config.storageSecretAccessKey
            ? {
                credentials: {
                  accessKeyId: this.config.storageAccessKeyId,
                  secretAccessKey: this.config.storageSecretAccessKey,
                },
              }
            : {}),
          // Bounded SDK retries (D7). Per-call cancellation is handled per-send
          // via an AbortSignal (`sendOptions()`), which times each object-store
          // call out independently of the app-wide request timeout — so a hung
          // store can't tie up a request slot.
          maxAttempts: this.config.storageMaxAttempts,
        });
        return { client, sdk: { ...clientMod, ...presignerMod } };
      })();
    }
    return this.clientPromise as Promise<{ client: S3Client; sdk: S3Sdk }>;
  }

  /** Per-call abort (D7): times a single object-store call out independently of
   *  the app-wide request timeout, so a hung store can't hold a request slot. */
  private sendOptions(): { abortSignal: AbortSignal } {
    return { abortSignal: AbortSignal.timeout(this.config.storageRequestTimeoutMs) };
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<PutObjectResult> {
    const { client, sdk } = await this.lazy();
    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Private object — reads only ever go through a presigned GET.
        ACL: 'private',
      }),
      this.sendOptions(),
    );
    const base = this.config.storageEndpoint || `https://${this.bucket}.s3.${this.config.storageRegion}.amazonaws.com`;
    return { url: `${base}/${key}` };
  }

  async deleteObject(key: string): Promise<void> {
    const { client, sdk } = await this.lazy();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: key }), this.sendOptions());
  }

  async copyObject(fromKey: string, toKey: string): Promise<void> {
    const { client, sdk } = await this.lazy();
    // Encode each path SEGMENT but keep the '/' separators intact.
    // encodeURIComponent(fromKey) over the whole key turns every '/' into
    // %2F; S3-compatible gateways like Supabase Storage do NOT decode that
    // back to '/', so the source object isn't found and the copy fails —
    // surfaced to the client as an opaque 503 storage_unavailable. (Stage's
    // putObject / getSignedUrl work because they pass the key un-encoded.)
    const copySource = `${this.bucket}/${fromKey
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    try {
      await client.send(
        new sdk.CopyObjectCommand({
          Bucket: this.bucket,
          CopySource: copySource,
          Key: toKey,
        }),
        this.sendOptions(),
      );
    } catch (err) {
      // copyStaged() collapses this into a bare StorageUnavailableError, so the
      // real cause (NoSuchKey / auth / unsupported op) is otherwise lost. Log it
      // here — object storage failures must be diagnosable server-side.
      this.logger.error(
        `S3 copyObject failed (source "${copySource}" → key "${toKey}"): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new StorageUnavailableError();
    }
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const { client, sdk } = await this.lazy();
    return sdk.getSignedUrl(
      client,
      new sdk.GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  async objectExists(key: string): Promise<boolean> {
    const { client, sdk } = await this.lazy();
    try {
      await client.send(new sdk.HeadObjectCommand({ Bucket: this.bucket, Key: key }), this.sendOptions());
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Minimal structural types for the lazily-loaded SDK (avoids a build-time
// dependency on @aws-sdk when the Local provider is used) ────────────────────
interface S3Client {
  send(command: unknown, options?: { abortSignal: AbortSignal }): Promise<unknown>;
}
interface S3ClientModule {
  S3Client: new (cfg: unknown) => S3Client;
  PutObjectCommand: new (input: unknown) => unknown;
  DeleteObjectCommand: new (input: unknown) => unknown;
  CopyObjectCommand: new (input: unknown) => unknown;
  GetObjectCommand: new (input: unknown) => unknown;
  HeadObjectCommand: new (input: unknown) => unknown;
}
interface S3PresignerModule {
  getSignedUrl: (client: unknown, command: unknown, opts: { expiresIn: number }) => Promise<string>;
}
type S3Sdk = S3ClientModule & S3PresignerModule;
