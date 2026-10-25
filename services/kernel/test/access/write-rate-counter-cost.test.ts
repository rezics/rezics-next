import { afterAll, expect, test } from 'bun:test';
import { Pool, type QueryConfig } from 'pg';
import type { AccessClient } from '../../src/request/access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: url, max: 1 });
afterAll(() => pool.end());

type Plan = {
  'Node Type': string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Tuples Inserted'?: number;
  'Conflicting Tuples'?: number;
  'Conflict Arbiter Indexes'?: string[];
  'Shared Hit Blocks': number;
  'Shared Read Blocks': number;
  Plans?: Plan[];
};
function nodes(plan: Plan): Plan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

test('one seed at three scales proves constant rows and one statement', async () => {
  const { spendWriteRateCounter } = await import('../../src/access/write-rate-counter.ts');
  const client = await pool.connect();
  try {
    await client.query('TRUNCATE access.write_rate_counter');
    // One cumulative seed grows both the measured family and unrelated keys.
    const measurements: { scale: number; units: number; allowed: boolean; blocks: number }[] = [];
    let previous = 0;
    for (const scale of [1, 8, 64]) {
      const size = 1024 * scale;
      await client.query(
        `INSERT INTO access.write_rate_counter (identity_digest, family, count, expires_at)
        SELECT md5(i::text) || md5(i::text), family, 0, statement_timestamp() + interval '1 day'
        FROM generate_series($1::integer, $2::integer) i CROSS JOIN (VALUES ('write'), ('unrelated')) f(family)`,
        [previous + 1, size],
      );
      previous = size;
      await client.query('ANALYZE access.write_rate_counter');
      const counts = await client.query(`SELECT family, count(*)::integer AS keys
        FROM access.write_rate_counter GROUP BY family ORDER BY family`);
      expect(counts.rows).toEqual([
        { family: 'unrelated', keys: size },
        { family: 'write', keys: size },
      ]);
      for (const units of [1, 100])
        for (const allowed of [true, false]) {
          await client.query(
            `UPDATE access.write_rate_counter SET count = $1
          WHERE identity_digest = md5('1') || md5('1') AND family = 'write'`,
            [allowed ? 0 : 1000],
          );
          const statements: QueryConfig[] = [];
          const captured = Object.create(client) as AccessClient;
          captured.query = ((query: QueryConfig) => {
            statements.push(query);
            return client.query(query);
          }) as AccessClient['query'];
          const result = await spendWriteRateCounter(captured, {
            identityDigest: 'c4ca4238a0b923820dcc509a6f75849b'.repeat(2),
            family: 'write',
            units,
            budget: { maximum: 1000, seconds: 60 },
          });
          expect(result.allowed).toBe(allowed);
          expect(statements).toHaveLength(1);
          const statement = statements[0]!;
          expect(statement.text).toMatch(/^\s*INSERT\s+INTO\s+access\.write_rate_counter/i);
          expect(statement.text).toMatch(/ON CONFLICT\s*\(identity_digest, family\) DO UPDATE/i);
          expect(statement.text).not.toMatch(/\b(?:SELECT|DELETE|BEGIN|COMMIT)\b/i);
          // Explain the exact captured product SQL and parameters, without planner overrides.
          const explained = await client.query({
            text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`,
            values: statement.values ?? [],
          });
          const plan = explained.rows[0]['QUERY PLAN'][0].Plan as Plan;
          expect(plan['Node Type']).toBe('ModifyTable');
          expect(plan['Conflict Arbiter Indexes']).toEqual(['write_rate_counter_pkey']);
          expect(plan['Tuples Inserted']).toBe(0);
          expect(plan['Conflicting Tuples']).toBe(1);
          const all = nodes(plan);
          expect(all.map((node) => node['Actual Rows'] * node['Actual Loops'])).toEqual([1, 1]);
          expect(all.some((node) => /Scan|Join|Aggregate/.test(node['Node Type']))).toBe(false);
          measurements.push({ scale, units, allowed, blocks: plan['Shared Hit Blocks'] + plan['Shared Read Blocks'] });
        }
    }
    for (const measurement of measurements) {
      const baseline = measurements.find(
        (m) => m.scale === 1 && m.units === measurement.units && m.allowed === measurement.allowed,
      )!;
      // A B-tree descent can add a page per level; two indexed keys grow by 64x.
      expect(measurement.blocks).toBeGreaterThan(0);
      expect(measurement.blocks).toBeLessThanOrEqual(baseline.blocks + 2 * Math.ceil(Math.log2(measurement.scale)));
    }
    console.info('write counter growth (shared hit + read blocks)', measurements);
  } finally {
    client.release();
  }
}, 30000);
