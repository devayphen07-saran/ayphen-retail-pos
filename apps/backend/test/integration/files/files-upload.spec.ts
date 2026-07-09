import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, DbModule, type Database } from '../../../src/db/db.module';
import { AppConfigModule } from '../../../src/config/config.module';
import { AppConfigService } from '../../../src/config/app-config.service';
import { RequestContextModule } from '../../../src/common/request-context/request-context.module';
import { RequestContextService } from '../../../src/common/request-context/request-context.service';
import { EntityTypesRepository } from '../../../src/entity-types/entity-types.repository';
import { FilesService } from '../../../src/files/files.service';
import { FilesRepository } from '../../../src/files/files.repository';
import { FilesConfigRepository } from '../../../src/files/files-config.repository';
import { FileValidationService } from '../../../src/files/file-validation.service';
import { LocalStorageProvider } from '../../../src/files/storage/local-storage.provider';
import { STORAGE_PROVIDER } from '../../../src/files/storage/storage.provider';
import type { IncomingFile } from '../../../src/files/file-validation.service';
import {
  accounts,
  accountUsers,
  users,
  stores,
  entityTypes,
  filesConfig,
  files,
  temporaryFiles,
} from '../../../src/db/schema';

/**
 * End-to-end coverage of the two-phase upload (table-architecture §33 / the
 * image-upload-architecture Part C hardening). Exercises the four properties
 * the old Java app got wrong: tenant isolation (owner-scoped temps + store-scoped
 * committed files), commit atomicity (one staged upload can never become two
 * `files` rows), content-sniff rejection (spoofed type / disguised markup), and
 * the sweeper reaping abandoned temps.
 */
describe('FilesService — two-phase upload', () => {
  let db: Database;
  let service: FilesService;
  let filesRepo: FilesRepository;
  let storage: LocalStorageProvider;
  let storageRoot: string;

  // Two users in the same account, two stores — the isolation fixtures.
  let userAId: string;
  let userBId: string;
  let storeAId: string;
  let storeBId: string;
  let accountId: string;
  let productEntityId: string; // supports attachments

  const RECORD = '11111111-1111-1111-1111-111111111111';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule, AppConfigModule, RequestContextModule],
      providers: [
        FilesService,
        FilesRepository,
        FilesConfigRepository,
        FileValidationService,
        EntityTypesRepository,
        LocalStorageProvider,
        { provide: STORAGE_PROVIDER, useExisting: LocalStorageProvider },
      ],
    }).compile();

    db = moduleRef.get(DRIZZLE);
    service = moduleRef.get(FilesService);
    filesRepo = moduleRef.get(FilesRepository);
    storage = moduleRef.get(LocalStorageProvider);
    storageRoot = resolve(moduleRef.get(AppConfigService).storageLocalDir);
  });

  afterAll(async () => {
    // The on-disk dev provider writes real files under STORAGE_LOCAL_DIR — clear
    // them so a test run doesn't leave staged/committed blobs behind.
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const [userA] = await db
      .insert(users)
      .values({ name: 'User A', phone: `+1${Math.floor(Math.random() * 1e9)}` })
      .returning();
    userAId = userA!.id;

    const [userB] = await db
      .insert(users)
      .values({ name: 'User B', phone: `+1${Math.floor(Math.random() * 1e9)}` })
      .returning();
    userBId = userB!.id;

    const [account] = await db
      .insert(accounts)
      .values({ accountNumber: `ACC-${userAId}`, name: 'Acct', ownerUserFk: userAId })
      .returning();
    accountId = account!.id;

    await db.insert(accountUsers).values([
      { accountFk: accountId, userFk: userAId },
      { accountFk: accountId, userFk: userBId },
    ]);

    const [storeA] = await db.insert(stores).values({ accountFk: accountId, name: 'Store A' }).returning();
    storeAId = storeA!.id;
    const [storeB] = await db.insert(stores).values({ accountFk: accountId, name: 'Store B' }).returning();
    storeBId = storeB!.id;

    const [product] = await db
      .insert(entityTypes)
      .values({ code: 'Product', label: 'Products', supportsAttachments: true })
      .returning();
    productEntityId = product!.id;

    // A second entity that does NOT support attachments (BR-7 negative path).
    await db
      .insert(entityTypes)
      .values({ code: 'Payment', label: 'Payments', supportsAttachments: false });

    // Entity-wide rule (file_kind NULL) for Product: 1 MB/file, 3 MB/record,
    // images + pdf, max 3 attachments.
    await db.insert(filesConfig).values({
      entityTypeFk: productEntityId,
      fileKind: null,
      maxFileSizeBytes: 1024 * 1024,
      maxConsolidatedSizeBytes: 3 * 1024 * 1024,
      validExtensions: 'jpg,jpeg,png,webp,gif,pdf',
      maxAttachmentsAllowed: 3,
      isActive: true,
    });
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  const runAs = <T>(userId: string, storeId: string | undefined, fn: () => Promise<T>): Promise<T> =>
    RequestContextService.run(
      { user: { userId } as never, requestId: '', ip: '', userAgent: '', storeId, accountId },
      fn,
    );

  // A minimal valid PNG (8-byte signature + padding) — passes the magic-byte sniff.
  const png = (name = 'photo.png', bytes = 64): IncomingFile => {
    const buffer = Buffer.alloc(bytes);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
    return { originalName: name, mimeType: 'image/png', size: buffer.length, buffer };
  };

  const stageProductPng = (userId: string, file: IncomingFile = png()) =>
    runAs(userId, undefined, () => service.stageUpload(file, 'Product', 'image'));

  // ── ingestion validation (content sniff / size / extension) ─────────────────

  it('stages a valid PNG and writes both the temp row and the object', async () => {
    const res = await stageProductPng(userAId);

    const [row] = await db.select().from(temporaryFiles).where(eq(temporaryFiles.guuid, res.guuid));
    expect(row).toBeDefined();
    expect(row!.uploadedBy).toBe(userAId);
    expect(await storage.objectExists(row!.storageKey)).toBe(true);
  });

  it('rejects a spoofed type — JPEG bytes uploaded as a .png (content sniff)', async () => {
    const jpegBytesPngName: IncomingFile = {
      originalName: 'evil.png',
      mimeType: 'image/png',
      size: 16,
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    };
    await expect(stageProductPng(userAId, jpegBytesPngName)).rejects.toMatchObject({
      errorCode: 'FILE_CONTENT_MISMATCH',
    });
    // Nothing must be persisted when ingestion rejects.
    const rows = await db.select().from(temporaryFiles);
    expect(rows).toHaveLength(0);
  });

  it('rejects SVG/markup disguised as an image (stored-XSS defence)', async () => {
    const svg: IncomingFile = {
      originalName: 'logo.png',
      mimeType: 'image/png',
      size: 40,
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    };
    await expect(stageProductPng(userAId, svg)).rejects.toMatchObject({ errorCode: 'FILE_CONTENT_MISMATCH' });
  });

  it('rejects a disallowed extension', async () => {
    await expect(stageProductPng(userAId, png('malware.exe'))).rejects.toMatchObject({
      errorCode: 'FILE_TYPE_NOT_ALLOWED',
    });
  });

  it('rejects a file over the per-file size cap', async () => {
    await expect(stageProductPng(userAId, png('big.png', 2 * 1024 * 1024))).rejects.toMatchObject({
      errorCode: 'FILE_TOO_LARGE',
    });
  });

  it('rejects an entity that does not support attachments', async () => {
    await expect(
      runAs(userAId, undefined, () => service.stageUpload(png(), 'Payment', 'image')),
    ).rejects.toMatchObject({ errorCode: 'ENTITY_DOES_NOT_SUPPORT_ATTACHMENTS' });
  });

  // ── commit / tenant isolation ───────────────────────────────────────────────

  it('commits a staged temp into a store-scoped file and clears the temp', async () => {
    const staged = await stageProductPng(userAId);

    const [committed] = await runAs(userAId, storeAId, () =>
      service.commit({
        entityType: 'Product',
        kind: 'image',
        recordGuuid: RECORD,
        fileGuuids: [staged.guuid],
        description: 'front label',
      }),
    );

    expect(committed.guuid).toBeDefined();
    // temp gone, exactly one committed file, scoped to store A, object present.
    expect(await db.select().from(temporaryFiles)).toHaveLength(0);
    const fileRows = await db.select().from(files);
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0]!.storeFk).toBe(storeAId);
    expect(fileRows[0]!.recordGuuid).toBe(RECORD);
    expect(await storage.objectExists(fileRows[0]!.storageKey)).toBe(true);
  });

  it('will not let a different user commit another user\'s staged temp (owner-scoped)', async () => {
    const staged = await stageProductPng(userAId);

    await expect(
      runAs(userBId, storeAId, () =>
        service.commit({
          entityType: 'Product',
          kind: 'image',
          recordGuuid: RECORD,
          fileGuuids: [staged.guuid],
        }),
      ),
    ).rejects.toMatchObject({ errorCode: 'TEMP_FILE_NOT_FOUND' });

    // User A's temp is untouched — no claim, still committable.
    const [temp] = await db.select().from(temporaryFiles).where(eq(temporaryFiles.guuid, staged.guuid));
    expect(temp!.claimedAt).toBeNull();
  });

  it('isolates committed files across stores — store B cannot see store A\'s file', async () => {
    const staged = await stageProductPng(userAId);
    const [committed] = await runAs(userAId, storeAId, () =>
      service.commit({
        entityType: 'Product',
        kind: 'image',
        recordGuuid: RECORD,
        fileGuuids: [staged.guuid],
      }),
    );

    // Same account, different store context → invisible.
    await expect(
      runAs(userAId, storeBId, () => service.getFile(committed.guuid)),
    ).rejects.toMatchObject({ errorCode: 'FILE_NOT_FOUND' });

    const listedFromB = await runAs(userAId, storeBId, () => service.listByRecord('Product', RECORD));
    expect(listedFromB).toHaveLength(0);

    const listedFromA = await runAs(userAId, storeAId, () => service.listByRecord('Product', RECORD));
    expect(listedFromA).toHaveLength(1);
  });

  // ── commit atomicity (the claimed_at gate) ──────────────────────────────────

  it('commits a staged upload exactly once under a concurrent double-commit', async () => {
    const staged = await stageProductPng(userAId);

    const commitOnce = () =>
      runAs(userAId, storeAId, () =>
        service.commit({
          entityType: 'Product',
          kind: 'image',
          recordGuuid: RECORD,
          fileGuuids: [staged.guuid],
        }),
      );

    const results = await Promise.allSettled([commitOnce(), commitOnce()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one wins the claim; the other aborts — and only ONE files row exists.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      errorCode: 'TEMP_FILE_NOT_FOUND',
    });
    expect(await db.select().from(files)).toHaveLength(1);
    expect(await db.select().from(temporaryFiles)).toHaveLength(0);
  });

  // ── commit-time record limits ───────────────────────────────────────────────

  it('enforces the per-record attachment count limit at commit', async () => {
    // Rule allows 3; pre-seed 3 active files on the record, then a 4th commit fails.
    for (let i = 0; i < 3; i++) {
      await db.insert(files).values({
        entityTypeFk: productEntityId,
        recordGuuid: RECORD,
        storeFk: storeAId,
        kind: 'image',
        storageKey: `${storeAId}/Product/${RECORD}/existing-${i}/f.png`,
        mimeType: 'image/png',
        sizeBytes: 1000,
      });
    }
    const staged = await stageProductPng(userAId);

    await expect(
      runAs(userAId, storeAId, () =>
        service.commit({
          entityType: 'Product',
          kind: 'image',
          recordGuuid: RECORD,
          fileGuuids: [staged.guuid],
        }),
      ),
    ).rejects.toMatchObject({ errorCode: 'FILE_ATTACHMENT_LIMIT_EXCEEDED' });

    // Rejected commit must not strand a claim — the temp is still committable.
    const [temp] = await db.select().from(temporaryFiles).where(eq(temporaryFiles.guuid, staged.guuid));
    expect(temp!.claimedAt).toBeNull();
  });

  // ── cancel / soft-delete / restore ──────────────────────────────────────────

  it('cancels an owner\'s staged upload and removes its object', async () => {
    const staged = await stageProductPng(userAId);
    const [before] = await db.select().from(temporaryFiles).where(eq(temporaryFiles.guuid, staged.guuid));

    await runAs(userAId, undefined, () => service.cancelStaged(staged.guuid));

    expect(await db.select().from(temporaryFiles)).toHaveLength(0);
    expect(await storage.objectExists(before!.storageKey)).toBe(false);
  });

  it('will not cancel another user\'s staged upload', async () => {
    const staged = await stageProductPng(userAId);
    await expect(
      runAs(userBId, undefined, () => service.cancelStaged(staged.guuid)),
    ).rejects.toMatchObject({ errorCode: 'TEMP_FILE_NOT_FOUND' });
    expect(await db.select().from(temporaryFiles)).toHaveLength(1);
  });

  it('soft-deletes then restores a committed file (store-scoped)', async () => {
    const staged = await stageProductPng(userAId);
    const [committed] = await runAs(userAId, storeAId, () =>
      service.commit({
        entityType: 'Product',
        kind: 'image',
        recordGuuid: RECORD,
        fileGuuids: [staged.guuid],
      }),
    );

    await runAs(userAId, storeAId, () => service.deleteFile(committed.guuid));
    expect(await runAs(userAId, storeAId, () => service.listByRecord('Product', RECORD))).toHaveLength(0);

    await runAs(userAId, storeAId, () => service.restoreFile(committed.guuid));
    expect(await runAs(userAId, storeAId, () => service.listByRecord('Product', RECORD))).toHaveLength(1);
  });

  // ── sweeper ─────────────────────────────────────────────────────────────────

  it('sweeps expired uncommitted temps and their objects, leaving fresh ones', async () => {
    // A fresh temp (via the real path) and an already-expired one (inserted directly).
    const fresh = await stageProductPng(userAId);

    const expiredKey = `tmp/${userAId}/expired/old.png`;
    await storage.putObject(expiredKey, png().buffer, 'image/png');
    await filesRepo.insertTemp({
      fileName: 'old.png',
      storageKey: expiredKey,
      sizeBytes: 64,
      mimeType: 'image/png',
      sha256: 'x'.repeat(64),
      uploadedBy: userAId,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const removed = await service.sweepExpiredTemps(500);

    expect(removed).toBe(1);
    expect(await storage.objectExists(expiredKey)).toBe(false);
    // The fresh, unexpired temp survives.
    const survivors = await db.select().from(temporaryFiles);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.guuid).toBe(fresh.guuid);
  });

  it('a committed file is never returned by a record query after commit (no leaked temp)', async () => {
    const staged = await stageProductPng(userAId);
    await runAs(userAId, storeAId, () =>
      service.commit({
        entityType: 'Product',
        kind: 'image',
        recordGuuid: RECORD,
        fileGuuids: [staged.guuid],
      }),
    );
    const active = await db
      .select()
      .from(files)
      .where(and(eq(files.storeFk, storeAId), isNull(files.deletedAt)));
    expect(active).toHaveLength(1);
  });
});
