import { CORE_REDIS } from '../../../src/auth/core/auth-core.module';

describe('CORE_REDIS symbol import', () => {
  it('is a defined Symbol, not undefined', () => {
    console.log('CORE_REDIS:', CORE_REDIS, typeof CORE_REDIS);
    expect(CORE_REDIS).toBeDefined();
    expect(typeof CORE_REDIS).toBe('symbol');
  });
});