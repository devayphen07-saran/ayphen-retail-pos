import { computeWaves, topoSort } from '../../../src/sync/push/delta.service.js';
import type { SyncMutation } from '../../../src/sync/dto/sync-delta.schema.js';

/** Minimal valid mutation builder — only the fields computeWaves/topoSort read. */
function m(
  id: string,
  guuid: string,
  opts: { parentGuuid?: string } = {},
): SyncMutation {
  return {
    mutation_id: id,
    entity_type: 'product',
    action: 'create',
    payload: { guuid },
    parent_guuid: opts.parentGuuid,
  } as SyncMutation;
}

const waveIndexOf = (waves: SyncMutation[][], mutationId: string): number =>
  waves.findIndex((wave) => wave.some((x) => x.mutation_id === mutationId));

describe('computeWaves (sync push batch parallelization)', () => {
  it('puts fully independent mutations in the same wave', () => {
    const mutations = [m('a', 'g1'), m('b', 'g2'), m('c', 'g3')];
    const waves = computeWaves(mutations);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(3);
  });

  it('puts a child in a strictly later wave than its parent (S-3a)', () => {
    const parent = m('parent', 'p-guuid');
    const child = m('child', 'c-guuid', { parentGuuid: 'p-guuid' });
    const waves = computeWaves([parent, child]);

    const parentWave = waveIndexOf(waves, 'parent');
    const childWave = waveIndexOf(waves, 'child');
    expect(childWave).toBeGreaterThan(parentWave);
  });

  it('chains a grandchild two waves after its grandparent', () => {
    const grandparent = m('gp', 'g1');
    const parent = m('p', 'g2', { parentGuuid: 'g1' });
    const child = m('c', 'g3', { parentGuuid: 'g2' });
    const waves = computeWaves([grandparent, parent, child]);

    expect(waveIndexOf(waves, 'gp')).toBe(0);
    expect(waveIndexOf(waves, 'p')).toBe(1);
    expect(waveIndexOf(waves, 'c')).toBe(2);
  });

  it('serializes repeated edits to the SAME entity guuid across waves, in input order', () => {
    // No parent_guuid link between these — but they touch the same entity,
    // so running them concurrently could apply them out of order.
    const first = m('edit1', 'same-entity');
    const second = m('edit2', 'same-entity');
    const waves = computeWaves([first, second]);

    const w1 = waveIndexOf(waves, 'edit1');
    const w2 = waveIndexOf(waves, 'edit2');
    expect(w2).toBeGreaterThan(w1);
  });

  it('does not force unrelated siblings of a shared parent into different waves', () => {
    const parent = m('parent', 'p-guuid');
    const childA = m('childA', 'a-guuid', { parentGuuid: 'p-guuid' });
    const childB = m('childB', 'b-guuid', { parentGuuid: 'p-guuid' });
    const waves = computeWaves([parent, childA, childB]);

    expect(waveIndexOf(waves, 'childA')).toBe(waveIndexOf(waves, 'childB'));
    expect(waveIndexOf(waves, 'childA')).toBeGreaterThan(waveIndexOf(waves, 'parent'));
  });

  it('composes correctly with topoSort output for a client-scrambled batch', () => {
    // Client sends the child before its parent — topoSort must still put the
    // parent first, and computeWaves must still keep the child in a later wave.
    const child = m('child', 'c-guuid', { parentGuuid: 'p-guuid' });
    const parent = m('parent', 'p-guuid');
    const sorted = topoSort([child, parent]);
    expect(sorted.map((x) => x.mutation_id)).toEqual(['parent', 'child']);

    const waves = computeWaves(sorted);
    expect(waveIndexOf(waves, 'child')).toBeGreaterThan(waveIndexOf(waves, 'parent'));
  });
});