import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
afterAll(() => pool.end());

test('a test file starts on a freshly migrated database that no other file has written', async () => {
  const { rows } = await pool.query(`SELECT
    (SELECT count(*)::int FROM core.partition WHERE position <> 0 OR epoch <> 1 OR write_state <> 'active') AS advanced,
    (SELECT count(*)::int FROM core.outbox) AS envelopes,
    (SELECT count(*)::int FROM core.consumer_checkpoint) AS checkpoints,
    (SELECT count(*)::int FROM semantic.subject) AS subjects,
    (SELECT count(*)::int FROM dbos.workflow_status) AS workflows`);
  expect(rows).toEqual([{ advanced: 0, envelopes: 0, checkpoints: 0, subjects: 0, workflows: 0 }]);
});
