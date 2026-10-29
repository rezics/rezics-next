import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  countedSample,
  countedViolations,
  type CountedCheck,
  type CountedSample,
  type CountedValues,
} from '../../kernel/test/support/growth-counters.ts';
import { RUN_TABLES, RunStore, type SourceProjection } from '../src/run-store';
import { createSqliteProbe } from './support/sqlite-growth';

const fixedCounts: CountedCheck<CountedValues> = {
  read: (counts) => counts,
  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
  slack: {
    'sqlite returned rows': { absolute: 2, relative: 0.1 },
    'sqlite statements': { absolute: 0, relative: 0 },
  },
};

test('sealed source projections use bounded indexed pages at three scales', () => {
  const samples: { scale: number; counted: CountedSample }[] = [];
  for (const scale of [32, 128, 512]) {
    const database = new Database(':memory:');
    const probe = createSqliteProbe(database, { growingTables: RUN_TABLES });
    const store = new RunStore<SourceProjection>(probe.database, { projectionMode: 'source-record' });
    try {
      const run = store.begin('wikidata');
      if (run === 'busy') throw new Error('Expected fresh run');
      for (let i = 0; i < scale; i++) {
        const key = `Q${String(i).padStart(6, '0')}`;
        store.stage(run, {
          row: {
            source: 'wikidata',
            recordKey: key,
            recordRevision: 'unversioned',
            digest: 'a'.repeat(64),
            converter_revision: 'test@1',
            state: 'present',
          },
          projection: { sourceKind: 'wikidata', normalizedRecord: { id: key, type: 'item', labels: {}, claims: {} } },
        });
      }
      expect(store.seal(run, { complete: true }).status).toBe('ready');
      database.exec('ANALYZE');
      const result = probe.measure(() => {
        expect(store.activeRun('wikidata')).toEqual(run);
        const page = store.pageStaged(run, { after: 'Q000001', limit: 3 });
        expect(page.map((entry) => entry.row.recordKey)).toEqual(['Q000002', 'Q000003', 'Q000004']);
        expect(store.pageAcknowledged('wikidata', { limit: 3 })).toEqual([]);
      });
      expect(result.counts['sqlite statements']).toBeGreaterThan(0);
      expect(result.counts['sqlite returned rows']).toBeGreaterThanOrEqual(3);
      probe.verifyPlans();
      samples.push({ scale, counted: countedSample([result.counts]) });
      expect(() => store.pageStaged(run, { limit: 101 })).toThrow();
      expect(() => store.pageAcknowledged('wikidata', { limit: 0 })).toThrow();
      expect(store.activeRun('bangumi')).toBeNull();
    } finally {
      probe.restore();
      store.close();
    }
  }
  expect(countedViolations(fixedCounts, samples)).toEqual([]);
});
