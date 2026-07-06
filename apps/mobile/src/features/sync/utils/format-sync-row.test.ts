import { summarize, entityLabel } from './format-sync-row';

describe('summarize', () => {
  it('uses the payload\'s name when present', () => {
    expect(summarize({ name: 'Sunrise Provisions' }, 'guuid-1')).toBe('Sunrise Provisions');
  });

  it('falls back to the guuid when name is missing', () => {
    expect(summarize({ sku: 'ABC' }, 'guuid-1')).toBe('guuid-1');
  });

  it('falls back to the guuid when name is an empty string', () => {
    expect(summarize({ name: '' }, 'guuid-1')).toBe('guuid-1');
  });

  it('falls back to the guuid when name is not a string', () => {
    expect(summarize({ name: 12345 }, 'guuid-1')).toBe('guuid-1');
  });

  it('falls back to the guuid for non-object payloads', () => {
    expect(summarize(null, 'guuid-1')).toBe('guuid-1');
    expect(summarize(undefined, 'guuid-1')).toBe('guuid-1');
    expect(summarize('a string', 'guuid-1')).toBe('guuid-1');
  });
});

describe('entityLabel', () => {
  it('capitalizes a single-word entity type', () => {
    expect(entityLabel('product')).toBe('Product');
  });

  it('capitalizes and de-underscores a multi-word entity type', () => {
    expect(entityLabel('product_case')).toBe('Product case');
  });

  it('handles an already-capitalized entity type without double-capitalizing', () => {
    expect(entityLabel('customer')).toBe('Customer');
  });
});