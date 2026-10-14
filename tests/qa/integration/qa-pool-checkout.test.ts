import { expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { readEnv } from '../../../scripts/dev/config.ts';
import { boundedPool, NestedPoolCheckoutError, nestedPoolCheckoutMode }
  from '../../../services/main/src/infrastructure/pg-pool.ts';

test('a QA stack saves throw mode for services and rejects nested checkout in its test process', async () => {
  const runId = process.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through the QA integration harness');
  const apps = readEnv(join(resolve(import.meta.dir, '../../..'), '.temp/stack', `rezics-qa-${runId}`, 'apps.env'));
  expect(apps.REZICS_NESTED_POOL_CHECKOUT).toBe('throw');
  expect(process.env.REZICS_NESTED_POOL_CHECKOUT).toBe('throw');
  expect(nestedPoolCheckoutMode()).toBe('throw');
  const pool = boundedPool({ connectionString: apps.CONTENT_DATABASE_URL, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await expect(pool.query('SELECT 1')).rejects.toBeInstanceOf(NestedPoolCheckoutError);
      expect((await client.query('SELECT 1 AS value')).rows[0].value).toBe(1);
    } finally { client.release(); }
    expect((await pool.query('SELECT 1 AS value')).rows[0].value).toBe(1);
  } finally { await pool.end(); }
});
