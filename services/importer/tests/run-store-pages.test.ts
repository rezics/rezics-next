import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { assertGrowth, type GrowthSample } from '../../kernel/test/support/growth-bound';
import { RUN_TABLES, RunStore, type SourceProjection } from '../src/run-store';
import { createSqliteProbe } from './support/sqlite-growth';

test('sealed source projections use bounded indexed pages at three scales', () => {
  const samples: GrowthSample[] = [];
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
      expect(result.cost.statements).toBeGreaterThan(0);
      expect(result.cost.rows).toBeGreaterThanOrEqual(3);
      probe.verifyPlans();
      samples.push({ scale, cost: result.cost });
      expect(() => store.pageStaged(run, { limit: 101 })).toThrow();
      expect(() => store.pageAcknowledged('wikidata', { limit: 0 })).toThrow();
      expect(store.activeRun('bangumi')).toBeNull();
    } finally {
      probe.restore();
      store.close();
    }
  }
  assertGrowth(samples, { rows: 'constant', blocks: 'constant', statements: 'constant' });
});
