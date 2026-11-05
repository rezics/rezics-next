import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import governance from '../../src/events/contracts/access-platform-governance.json';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
afterAll(() => pool.end());

test('governance reach constraint matches the platform catalogue', async () => {
  const result = await pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conrelid = 'access.governance_reach'::regclass
       AND conname = 'governance_reach_action_check'`,
  );
  expect(result.rowCount).toBe(1);

  const actions = [...result.rows[0]!.definition.matchAll(/'([^']+)'::text/g)].map((match) => match[1]).sort();
  expect(actions).toEqual([...governance.globalReach].sort());
});
