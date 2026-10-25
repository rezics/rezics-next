import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RunStore, type SourceProjection } from '../src/run-store.ts';

test('native Open Library slash keys survive durable staging and acknowledgement unchanged', () => {
  const db = new Database(':memory:');
  const store = new RunStore<SourceProjection>(db, { projectionMode: 'source-record' });
  try {
    const run = store.begin('open-library');
    if (run === 'busy') throw new Error('unexpected busy');
    const keys = ['/works/OL100000W', '/books/OL100001M', '/authors/OL100002A'];
    for (const recordKey of keys)
      store.stage(run, {
        row: {
          source: 'open-library',
          recordKey,
          recordRevision: 'unversioned',
          digest: 'a'.repeat(64),
          converter_revision: 'test@1',
          state: 'present',
        },
        projection: { sourceKind: 'openlibrary', normalizedRecord: { key: recordKey } },
      });
    expect(store.seal(run, { complete: true }).status).toBe('ready');
    expect(store.pageStaged(run, { limit: 10 }).map((r) => r.row.recordKey)).toEqual([...keys].sort());
    for (const key of keys) {
      store.classify(run, key, { commands: [] });
      store.acknowledgeNoEffects(run, key, { reason: 'no-owned-candidates' });
    }
    let result = store.finalize(run, 2);
    while (result === 'more') result = store.finalize(run, 2);
    expect(result).toBe('complete');
    for (const key of keys) expect(store.key('open-library', key).acknowledged?.recordKey).toBe(key);
  } finally {
    store.close();
    db.close();
  }
});
