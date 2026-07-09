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
  private readonly log = new Logger(S3StorageProvider.name);
  private readonly bucket: string;
  private clientPromise?: Promise<{ client: unknown; sdk: S3Sdk }>;

  constructor(private readonly config: AppConfigService) {
    this.bucket = this.config.storageBucket;
    this.log.log(
      `Object storage: S3-compatible bucket "${this.bucket}" (region ${this.config.storageRegion}` +
        (this.config.storageEndpoint ? `, endpoint ${this.config.storageEndpoint}` : '') +
        ').',
    );
  }

  /** Lazily construct the S3 client + capture the SDK's command classes. */
  private async lazy(): Promise<{ client: any; sdk: S3Sdk }> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        let clientMod: S3ClientModule;
        let presignerMod: S3PresignerModule;
        try {
          // Non-literal specifiers: TS treats these as `any` and skips static
          // resolution, so the build doesn't require the packages to be present.
          const clientSpec = '@aws-sdk/client-s3';
          const presignerSpec = '@aws-sdk/s3-request-presigner';
          clientMod = (await import(clientSpec)) as S3ClientModule;
          presignerMod = (await import(presignerSpec)) as S3PresignerModule;
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
          // Bound the outbound call so a slow S3 can't hang the request thread
          // (Part C / P1-6). 15s covers a 10MB upload on a modest link.
          requestHandler: undefined,
        });
        return { client, sdk: { ...clientMod, ...presignerMod } };
      })();
    }
    return this.clientPromise as Promise<{ client: any; sdk: S3Sdk }>;
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
    );
    const base = this.config.storageEndpoint || `https://${this.bucket}.s3.${this.config.storageRegion}.amazonaws.com`;
    return { url: `${base}/${key}` };
  }

  async deleteObject(key: string): Promise<void> {
    const { client, sdk } = await this.lazy();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async copyObject(fromKey: string, toKey: string): Promise<void> {
    const { client, sdk } = await this.lazy();
    await client.send(
      new sdk.CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${encodeURIComponent(fromKey)}`,
        Key: toKey,
      }),
    );
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
      await client.send(new sdk.HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Minimal structural types for the lazily-loaded SDK (avoids a build-time
// dependency on @aws-sdk when the Local provider is used) ────────────────────
interface S3ClientModule {
  S3Client: new (cfg: unknown) => unknown;
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
