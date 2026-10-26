import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertGrowth, type GrowthSample } from '../../kernel/test/support/growth-bound.ts';
import { RecordStore, type RecordRow } from '../src/record-store.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';

const SCALES = [1, 8, 64] as const;
const DIGEST = 'a'.repeat(64);
const seedSequence = `WITH RECURSIVE seq(n) AS (
  SELECT ?
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < ?
) `;

function seedHistory(database: RecordStore['database'], from: number, through: number) {
  if (from > through) return;
  database
    .query(
      `${seedSequence}INSERT INTO acknowledged_records
      (source,record_key,record_revision,digest,converter_revision,state)
    SELECT 'history' || n, 'Q' || printf('%05d', n), 'unversioned', ?, 'fixture@1', 'present' FROM seq`,
    )
    .run(from, through, DIGEST);
  database
    .query(
      `${seedSequence}INSERT INTO record_source_counts (source,present_count)
    SELECT 'history' || n, 1 FROM seq`,
    )
    .run(from, through);
}

function seedMeasurementRows(database: RecordStore['database']) {
  for (const scale of SCALES)
    database.query(`INSERT INTO record_source_counts (source,present_count) VALUES (?,0)`).run(`growth${scale}`);
}

function presentRecord(source: string, recordKey: string): RecordRow {
  return {
    source,
    recordKey,
    recordRevision: 'unversioned',
    digest: DIGEST,
    converter_revision: 'fixture@1',
    state: 'present',
  };
}

test('Record upsert stays within its bound as R grows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'record-store-growth-'));
  let probe!: ReturnType<typeof createSqliteProbe>;
  const store = new RecordStore(resolve(directory, 'records.sqlite'), {
    instrumentDatabase(database) {
      probe = createSqliteProbe(database, {
        growingTables: ['acknowledged_records', 'record_source_counts'],
      });
      return database;
    },
  });
  const samples: GrowthSample[] = [];

  try {
    seedMeasurementRows(store.database);
    let seeded = 0;

    for (const scale of SCALES) {
      const target = 500 * scale;
      seedHistory(store.database, seeded + 1, target);
      seeded = target;
      store.database.exec('ANALYZE');

      const source = `growth${scale}`;
      const key = `QMEASURE${scale}`;
      const measured = probe.measure(() => store.put(presentRecord(source, key)));
      probe.verifyPlans();
      expect(store.count(source)).toBe(1);
      samples.push({ scale, cost: measured.cost });
    }

    assertGrowth(samples, { rows: 'constant', blocks: 'constant', statements: 'constant' });
  } finally {
    store.close();
    probe.restore();
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
