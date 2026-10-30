import { expect, test } from 'bun:test';
import { capture, checkGrowth, openGrowthDatabase } from './growth.ts';

test('a warmup observer retains inner capture work and backend identity without changing its local plan indexes', async () => {
  const db = await openGrowthDatabase();
  db.pool.options.max = 1;
  try {
    const observed = await capture(
      db,
      async () => {
        await db.pool.query('SELECT 1 AS before');
        const inner = await capture(db, async () => {
          await db.pool.query('SELECT 2 AS inside');
        });
        await db.pool.query('SELECT 3 AS after');
        return inner.capture;
      },
      { includeBackends: true, observeNested: true },
    );
    expect(observed.capture.statements).toEqual(['SELECT 1 AS before', 'SELECT 2 AS inside', 'SELECT 3 AS after']);
    expect(observed.capture.planStatements).toEqual([0, 1, 2]);
    expect(observed.capture.plans).toHaveLength(3);
    expect(observed.value.statements).toEqual(['SELECT 2 AS inside']);
    expect(observed.value.planStatements).toEqual([0]);
    expect(observed.value.plans).toHaveLength(1);
    expect(observed.value.statementBackends).toEqual([observed.capture.statementBackends![1]]);
    expect(observed.value.statementBackends![0]).toBeNumber();

    const statement = 'SELECT partition_no FROM core.partition WHERE partition_no = 0';
    const report = await checkGrowth(db, {
      name: 'warmup hook with its own plan capture',
      scales: [1, 4, 16],
      repetitions: 1,
      bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
      grow: async () => {},
      warmup: async () => {
        const inner = await capture(db, () => db.pool.query(statement));
        expect(inner.capture.statements).toEqual([statement]);
        expect(inner.capture.planStatements).toEqual([0]);
      },
      operation: () => db.pool.query(statement),
    });
    expect(report.samples.map(({ coldBackendDiscards }) => coldBackendDiscards)).toEqual([0, 0, 0]);
    expect(report.samples.map(({ cost }) => cost.statements)).toEqual([1, 1, 1]);
    expect(report.samples.map(({ cost }) => cost.rows)).toEqual([1, 1, 1]);
    const following = await capture(db, () => db.pool.query('SELECT 5 AS following'));
    expect(following.capture.statements).toEqual(['SELECT 5 AS following']);
  } finally {
    await db.close();
  }
});
