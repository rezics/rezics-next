import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RunStore, type Run, type SourceProjection } from '../src/run-store.ts';

const source = 'wikidata';
const staged = (key: string) => ({
  row: {
    source,
    recordKey: key,
    recordRevision: 'unversioned',
    digest: 'a'.repeat(64),
    converter_revision: 'test@1',
    state: 'present' as const,
  },
  projection: {
    sourceKind: 'wikidata' as const,
    normalizedRecord: { id: key, type: 'item', labels: {}, aliases: {}, descriptions: {}, claims: {} },
  },
});
function setup() {
  const db = new Database(':memory:');
  const store = new RunStore<SourceProjection>(db, { projectionMode: 'source-record' });
  const begin = () => {
    const run = store.begin(source);
    if (run === 'busy') throw new Error('unexpected busy');
    return run;
  };
  const finish = (run: Run) => {
    let result = store.finalize(run, 1);
    while (result === 'more') result = store.finalize(run, 1);
    return result;
  };
  return { db, store, begin, finish };
}

test('explicit converter ignored record acknowledges without invented commands or fence proof', () => {
  const h = setup();
  try {
    const run = h.begin();
    h.store.stage(run, staged('Q1'));
    expect(h.store.seal(run, { complete: true }).status).toBe('ready');
    h.store.classify(run, 'Q1', { commands: [] });
    expect(h.finish(run)).toBe('incomplete');
    h.store.acknowledgeNoEffects(run, 'Q1', { reason: 'converter-ignored' });
    expect(h.store.pagePending(run, { limit: 8 })).toEqual([]);
    expect(h.store.key(source, 'Q1', run).omissions).toEqual([]);
    expect(h.finish(run)).toBe('complete');
    expect(h.store.key(source, 'Q1').acknowledged).toEqual(staged('Q1').row);
  } finally {
    h.store.close();
    h.db.close();
  }
});

test('explicit zero-effect acknowledgement rejects missing and cross-source identities', () => {
  const h = setup();
  try {
    const run = h.begin();
    h.store.stage(run, staged('Q1'));
    h.store.seal(run, { complete: true });
    expect(() => h.store.acknowledgeNoEffects(run, 'Q404', { reason: 'converter-ignored' })).toThrow();
    expect(() =>
      h.store.acknowledgeNoEffects({ ...run, source: 'other' }, 'Q1', { reason: 'converter-ignored' }),
    ).toThrow();
    expect(h.finish(run)).toBe('incomplete');
  } finally {
    h.store.close();
    h.db.close();
  }
});
