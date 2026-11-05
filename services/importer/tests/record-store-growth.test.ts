import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { countedSample, countedViolations, type CountedCheck } from '../../kernel/test/support/growth-counters.ts';

import { RecordStore, type RecordRow } from '../src/record-store.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';

type Sample = { scale: number; counted: ReturnType<typeof countedSample> };

const constant: CountedCheck = {
  read: (value) => value as Record<string, number>,
  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
};

const SCALES = [64, 512, 4096] as const;
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
    SELECT 'growth', 'Q' || printf('%05d', n), 'unversioned', ?, 'fixture@1', 'present' FROM seq`,
    )
    .run(from, through, DIGEST);
  database
    .query(`INSERT INTO record_source_counts (source,present_count) VALUES ('growth',?)
    ON CONFLICT(source) DO UPDATE SET present_count=present_count+excluded.present_count`)
    .run(through - from + 1);
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
  const samples: Sample[] = [];

  try {
    let seeded = 0;

    for (const scale of SCALES) {
      const target = scale;
      seedHistory(store.database, seeded + 1, target);
      seeded = target;
      expect(
        store.database
          .query("SELECT count(*) AS n FROM acknowledged_records WHERE source='growth' AND record_key LIKE 'Q0%'")
          .get(),
      ).toEqual({ n: scale });
      expect(store.database.query('SELECT count(*) AS n FROM record_source_counts').get()).toEqual({ n: 1 });
      expect(store.database.query('SELECT count(*) AS n FROM acknowledged_records').get()).toEqual({
        n: scale + samples.length,
      });
      store.database.exec('ANALYZE');

      const source = 'growth';
      const key = `QMEASURE${scale}`;
      const measured = probe.measure(() => store.put(presentRecord(source, key)));
      probe.verifyPlans();
      expect(store.count(source)).toBe(scale + samples.length + 1);
      // The Cost row permits three point statements plus BEGIN/COMMIT.
      expect(measured.counts['sqlite returned rows']).toBeLessThanOrEqual(1);
      expect(measured.counts['sqlite statements']).toBe(5);
      expect(measured.statements.some((event) => event.plan.some((plan) => /^SEARCH\b/.test(plan.detail)))).toBe(true);
      samples.push({ scale, counted: countedSample([measured.counts]) });
    }

    expect(countedViolations(constant, samples)).toEqual([]);
  } finally {
    store.close();
    probe.restore();
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
