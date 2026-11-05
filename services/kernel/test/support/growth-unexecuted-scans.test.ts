import { expect, test } from 'bun:test';
import pg from 'pg';
import { costOf } from './growth-cost.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

test('an unexecuted sequential scan contributes no scan, while an executed empty scan still counts', async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TEMP TABLE scan_probe (value integer);
      INSERT INTO scan_probe SELECT generate_series(1, 100);
      CREATE TEMP TABLE scan_gate (value integer);
    `);
    const result = await client.query(`
      EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)
      SELECT * FROM scan_probe WHERE (SELECT count(*) FROM scan_gate) > 0
    `);
    const plan = result.rows[0]['QUERY PLAN'];
    const scans: Record<string, Record<string, unknown>> = {};
    function visit(node: Record<string, unknown>) {
      if (node['Node Type'] === 'Seq Scan') scans[node['Relation Name'] as string] = node;
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
    }
    visit(plan[0].Plan);
    expect(scans.scan_probe?.['Actual Loops']).toBe(0);
    expect(scans.scan_gate?.['Actual Loops']).toBe(1);
    const cost = costOf({ statements: [], plans: [plan] });
    const relation = (name: string) =>
      Object.entries(cost.relations).find(([key]) => key === name || key.endsWith(`.${name}`))?.[1];
    expect(relation('scan_probe')).toMatchObject({ rows: 0, blocks: 0, sequentialScans: 0 });
    expect(relation('scan_gate')).toMatchObject({ rows: 0, sequentialScans: 1 });
  } finally {
    await client.end();
  }
});
