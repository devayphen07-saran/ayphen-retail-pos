import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { DRIZZLE, DbModule, type Database } from '../../../src/db/db.module';
import { EntityTypesRepository } from '../../../src/entity-types/entity-types.repository';
import { EntityTypesService } from '../../../src/entity-types/entity-types.service';
import { entityTypes } from '../../../src/db/schema';

/**
 * Wiring the previously-orphaned entity_types table (lookup-entity-prd.md P0,
 * acceptance criterion: "entity_types is read by at least one repository").
 */
describe('EntityTypesRepository / EntityTypesService', () => {
  let db: Database;
  let repo: EntityTypesRepository;
  let service: EntityTypesService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule],
      providers: [EntityTypesRepository, EntityTypesService],
    }).compile();

    db = moduleRef.get(DRIZZLE);
    repo = moduleRef.get(EntityTypesRepository);
    service = moduleRef.get(EntityTypesService);
  });

  afterEach(async () => {
    await db.delete(entityTypes);
  });

  it('findByCode returns the row for a seeded code', async () => {
    await db.insert(entityTypes).values({
      code: 'Product',
      label: 'Products',
      isOfflineSafe: true,
      supportsAttachments: true,
    });

    const row = await repo.findByCode('Product');
    expect(row?.code).toBe('Product');
    expect(row?.supportsAttachments).toBe(true);
  });

  it('findByCode returns null for an unknown code', async () => {
    expect(await repo.findByCode('DoesNotExist')).toBeNull();
  });

  it('service.findByCode throws NotFoundException(ENTITY_TYPE_NOT_FOUND) for an unknown code', async () => {
    await expect(service.findByCode('DoesNotExist')).rejects.toMatchObject({
      message: 'ENTITY_TYPE_NOT_FOUND',
    });
  });

  it('listOfflineSafe returns only rows with isOfflineSafe=true', async () => {
    await db.insert(entityTypes).values([
      { code: 'Product', label: 'Products', isOfflineSafe: true, supportsAttachments: true },
      { code: 'Report', label: 'Reports', isOfflineSafe: false, supportsAttachments: false },
    ]);

    const rows = await repo.listOfflineSafe();
    expect(rows.map((r) => r.code)).toEqual(['Product']);
  });

  it('supportsAttachments (BR-7) reflects the row flag, false for an unknown code', async () => {
    await db.insert(entityTypes).values({
      code: 'Customer',
      label: 'Customers',
      isOfflineSafe: true,
      supportsAttachments: true,
    });

    expect(await repo.supportsAttachments('Customer')).toBe(true);
    expect(await repo.supportsAttachments('Unknown')).toBe(false);

    // Flip the flag — an entity that exists but doesn't allow attachments.
    await db.update(entityTypes).set({ supportsAttachments: false }).where(eq(entityTypes.code, 'Customer'));
    expect(await repo.supportsAttachments('Customer')).toBe(false);
  });
});