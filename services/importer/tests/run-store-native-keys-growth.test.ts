import { expect, test } from 'bun:test';
import { assertGrowth, type GrowthSample } from '../../kernel/test/support/growth-bound.ts';
import { RUN_TABLES, RunStore, type Run, type SourceProjection } from '../src/run-store.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';

const source = 'open-library';
const keys = ['/authors/OL100002A', '/books/OL100001M', '/works/OL100000W'];
const disposition = { reason: 'no-owned-candidates' } as const;
const record = (recordKey: string, revision = 1) => ({
  row: {
    source,
    recordKey,
    recordRevision: String(revision),
    digest: 'a'.repeat(64),
    converter_revision: 'test@1',
    state: 'present' as const,
  },
  projection: { sourceKind: 'openlibrary' as const, normalizedRecord: { key: recordKey } },
});
function begin(store: RunStore<SourceProjection>): Run {
  const run = store.begin(source);
  if (run === 'busy') throw new Error('Unexpected busy source');
  return run;
}
function finish(store: RunStore<SourceProjection>, run: Run) {
  let result = store.finalize(run, 100);
  while (result === 'more') result = store.finalize(run, 100);
  expect(result).toBe('complete');
}

test('native slash key stage/get and page/ack stay indexed across same-source history and current keys', () => {
  let probe!: ReturnType<typeof createSqliteProbe>;
  const store = new RunStore<SourceProjection>(':memory:', {
    projectionMode: 'source-record',
    instrumentDatabase(db) {
      probe = createSqliteProbe(db, { growingTables: RUN_TABLES });
      return probe.database;
    },
  });
  const samples = new Map<string, GrowthSample[]>();
  let previous = 0;
  try {
    const initial = begin(store);
    for (const key of keys) store.stage(initial, record(key));
    store.seal(initial, { complete: true });
    for (const key of keys) {
      store.classify(initial, key, { commands: [] });
      store.acknowledgeNoEffects(initial, key, disposition);
    }
    finish(store, initial);
    for (const scale of [32, 128, 512]) {
      // Grow one real SQLite seed: failed historical runs and unrelated live keys share the source.
      for (; previous < scale; previous++) {
        const history = begin(store);
        store.stage(history, record(`History${previous}`));
        expect(store.seal(history, { complete: false, reason: 'truncated' }).status).toBe('invalid-input');
      }
      const run = begin(store);
      for (let i = 0; i < scale; i++) store.stage(run, record(`Current${i}`));
      store.database.exec('ANALYZE');
      const measure = <T>(name: string, operation: () => T) => {
        const result = probe.measure(operation);
        expect(result.cost.blocks).toBe(0); // Buffer counters are unavailable, not evidence of zero IO.
        expect(result.cost.statements).toBeGreaterThan(0);
        expect(result.cost.statements).toBeLessThanOrEqual(8);
        expect(result.cost.rows).toBeLessThanOrEqual(5);
        if (/^(?:stage|ack) \//.test(name))
          expect(result.statements.filter((event) => event.kind === 'control').map((event) => event.sql)).toEqual([
            'BEGIN IMMEDIATE',
            'COMMIT',
          ]);
        const searches = result.statements.flatMap((event) => event.plan).filter((row) => /^SEARCH\b/.test(row.detail));
        expect(searches.length).toBeGreaterThan(0);
        for (const search of searches) expect(search.detail).toMatch(/\(source=\?/);
        probe.verifyPlans();
        const group = samples.get(name) ?? [];
        group.push({ scale, cost: result.cost });
        samples.set(name, group);
        return result.value;
      };
      for (const key of keys) {
        measure(`stage ${key}`, () => store.stage(run, record(key, scale)));
        expect(measure(`get ${key}`, () => store.key(source, key, run)).staged).toEqual(record(key, scale));
      }
      expect(store.seal(run, { complete: true }).status).toBe('ready');
      expect(measure('first page', () => store.pageStaged(run, { limit: 3 }))).toEqual(
        keys.map((key) => record(key, scale)),
      );
      expect(measure('cursor page', () => store.pageStaged(run, { after: keys[0]!, limit: 2 }))).toEqual(
        keys.slice(1).map((key) => record(key, scale)),
      );
      for (const key of keys) {
        store.classify(run, key, { commands: [] });
        measure(`ack ${key}`, () => store.acknowledgeNoEffects(run, key, disposition));
        expect(measure(`ack get ${key}`, () => store.key(source, key, run)).acknowledged).toEqual(
          record(key, scale).row,
        );
      }
      expect(measure('ack cursor page', () => store.pageAcknowledged(source, { after: keys[0]!, limit: 2 }))).toEqual(
        keys.slice(1).map((key) => record(key, scale).row),
      );
      for (let i = 0; i < scale; i++) {
        store.classify(run, `Current${i}`, { commands: [] });
        store.acknowledgeNoEffects(run, `Current${i}`, disposition);
      }
      finish(store, run);
    }
    for (const group of samples.values())
      assertGrowth(
        group,
        { rows: 'constant', blocks: 'constant', statements: 'constant' },
        {
          rows: { absolute: 0, relative: 0 },
          blocks: { absolute: 0, relative: 0 },
        },
      );
  } finally {
    probe.restore();
    store.close();
  }
});

test('native slash key exception preserves identifier, metadata, JSON and capability validation', () => {
  const store = new RunStore<SourceProjection>(':memory:', { projectionMode: 'source-record' });
  try {
    let run = begin(store);
    for (const key of [
      '',
      '/Q1',
      '//works/OL1W',
      '/works/OL1M',
      '/books/OL1W',
      '/authors/OL1W',
      '/works/OL0W',
      '/works/OL01W',
      '/works/OL1W/extra',
      '/works/../OL1W',
      '/works/OL1W\n',
      '/works/OL1W\0',
      '/works/OL1 W',
      '/works/OL1W%20',
      `/works/OL${'1'.repeat(503)}W`,
      '.Q1',
      '_Q1',
      '-Q1',
      'Q1\n',
      'é'.repeat(257),
    ]) {
      expect(() => store.stage(run, record(key))).toThrow();
      expect(() => store.key(source, key, run)).toThrow();
      expect(() => store.pageStaged(run, { after: key, limit: 1 })).toThrow();
    }
    const target = record(keys[0]!);
    expect(() => store.stage(run, { ...target, row: { ...target.row, source: 'wikidata' } })).toThrow();
    expect(() => store.stage(run, { ...target, row: { ...target.row, recordRevision: '1\n' } })).toThrow();
    let invoked = false;
    const unsafe = {
      get key() {
        invoked = true;
        return keys[0];
      },
    };
    for (const normalizedRecord of [unsafe, { body: 'x'.repeat(65536) }])
      expect(() => store.stage(run, { ...target, projection: { ...target.projection, normalizedRecord } })).toThrow();
    expect(invoked).toBe(false);
    for (const key of [`/works/OL${'1'.repeat(502)}W`, 'é:/@+._-1']) {
      store.stage(run, record(key));
      expect(store.key(source, key, run).staged).toEqual(record(key));
    }
    const stale = run;
    run = store.reopen(run);
    expect(() => store.stage(stale, target)).toThrow();
    store.stage(run, target);
    expect(() => store.key('wikidata', keys[0]!, run)).toThrow();
    store.seal(run, { complete: true });
    store.classify(run, keys[0]!, { commands: [] });
    expect(() => store.acknowledgeNoEffects(stale, keys[0]!, disposition)).toThrow();
    expect(() => store.pageStaged(stale, { limit: 1 })).toThrow();
    store.acknowledgeNoEffects(run, keys[0]!, disposition);
    expect(store.key(source, keys[0]!).acknowledged).toEqual(target.row);
  } finally {
    store.close();
  }
});
