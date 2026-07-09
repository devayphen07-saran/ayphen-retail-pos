import { SyncFilterRegistry } from '../../../src/sync/registry/sync-filter.registry.js';

describe('SyncFilterRegistry.unknownTypes', () => {
  const registry = new SyncFilterRegistry();

  it('returns nothing when no types are requested', () => {
    expect(registry.unknownTypes(undefined)).toEqual([]);
    expect(registry.unknownTypes([])).toEqual([]);
  });

  it('returns nothing when every requested type is registered', () => {
    expect(registry.unknownTypes(['store', 'taxrate', 'customer'])).toEqual([]);
  });

  it('flags a casing mismatch against the intentionally non-snake_case wire strings', () => {
    // taxrate/paymentaccount are deliberately concatenated, not snake_case
    // (sync.constants.ts) — a client sending the "readable" spelling would
    // otherwise silently lose that entity from every pull forever.
    expect(registry.unknownTypes(['tax_rate'])).toEqual(['tax_rate']);
    expect(registry.unknownTypes(['payment_account'])).toEqual(['payment_account']);
  });

  it('flags only the unrecognized entries, leaving known ones out of the result', () => {
    expect(registry.unknownTypes(['store', 'bogus_entity', 'customer'])).toEqual(['bogus_entity']);
  });

  it('does not confuse "unknown to the registry" with "not yet supported()-matched" — supported() narrowing is a separate, expected case', () => {
    // A type absent from supportedEntityTypes isn't "unknown" — supported()
    // already models "server has more entities than an older client knows
    // about" by simply not returning them. unknownTypes() only flags the
    // opposite direction: a requested type the registry has never heard of.
    const requestedSubset = ['store'];
    expect(registry.unknownTypes(requestedSubset)).toEqual([]);
    expect(registry.supported(requestedSubset).map((f) => f.entityType)).toEqual(['store']);
  });
});