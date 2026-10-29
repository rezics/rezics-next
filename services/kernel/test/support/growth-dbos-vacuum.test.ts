import { expect, spyOn, test } from 'bun:test';
import { checkGrowth, openGrowthDatabase } from './growth.ts';

const scales = [1, 4, 16] as const;
const bounds = { rows: 'constant', blocks: 'constant', statements: 'constant' } as const;
const vacuum = 'VACUUM (INDEX_CLEANUP ON) "dbos"."workflow_status"';

test('checkGrowth measures a database that has no dbos schema', async () => {
  const db = await openGrowthDatabase();
  const queries = spyOn(db.admin, 'query');
  try {
    // The kernel check gives this file its own migrated database, including DBOS.
    await db.admin.query('DROP SCHEMA IF EXISTS dbos CASCADE');
    expect((await db.admin.query(`SELECT to_regnamespace('dbos') AS schema`)).rows[0].schema).toBeNull();
    const report = await checkGrowth(db, {
      name: 'growth without DBOS tables',
      scales,
      bounds,
      warmups: 1,
      repetitions: 1,
      grow: async () => {},
      operation: async () => {
        await db.pool.query('SELECT 42 AS answer');
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
    expect(report.samples.map(({ cost }) => cost.statements)).toEqual([1, 1, 1]);
    expect(queries.mock.calls.filter(([statement]) => statement === vacuum)).toHaveLength(0);
  } finally {
    queries.mockRestore();
    await db.close();
  }
});

test('checkGrowth settles dbos.workflow_status before measured repetitions once the schema exists', async () => {
  const db = await openGrowthDatabase();
  const queries = spyOn(db.admin, 'query');
  const vacuumCounts: number[] = [];
  let created = false;
  try {
    await db.admin.query('DROP SCHEMA IF EXISTS dbos CASCADE');
    expect((await db.admin.query(`SELECT to_regnamespace('dbos') AS schema`)).rows[0].schema).toBeNull();
    const report = await checkGrowth(db, {
      name: 'growth with DBOS tables created between repetitions',
      scales,
      bounds,
      warmups: 1,
      repetitions: 2,
      grow: async () => {},
      operation: async (_, scale) => {
        vacuumCounts.push(queries.mock.calls.filter(([statement]) => statement === vacuum).length);
        // Introduce DBOS after the first scale, during a measured operation, so even the next run must recheck.
        if (scale === 4 && !created) {
          await db.admin.query('CREATE SCHEMA dbos');
          created = true;
          await db.admin.query('CREATE TABLE dbos.workflow_status (id integer PRIMARY KEY)');
        }
        await db.pool.query('SELECT 42 AS answer');
      },
    });
    // Warmups are captured, and maintenance runs immediately before every measured repetition after a write.
    expect(vacuumCounts).toEqual([0, 0, 0, 0, 1, 2, 2, 3, 4]);
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
    expect(report.samples.map(({ cost }) => cost.statements)).toEqual([1, 1, 1]);
  } finally {
    queries.mockRestore();
    try {
      if (created) await db.admin.query('DROP SCHEMA dbos CASCADE');
    } finally {
      await db.close();
    }
  }
});
