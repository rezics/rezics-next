import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { preserveReapEnvironment } from '../../../scripts/qa/container-reaper.ts';

test('native QA containers can read checkout initialization and open owner databases', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through isolated integration QA');
  const readable = spawnSync('docker', ['exec', '--user', '999',
    `rezics-qa-${runId}-postgres-1`, 'sh', '-ec',
    'test -r /docker-entrypoint-initdb.d/00-owners.sh && test -x /docker-entrypoint-initdb.d/00-owners.sh'],
  { encoding: 'utf8', timeout: 10_000, env: preserveReapEnvironment(process.env) });
  expect(readable.status, readable.stderr).toBe(0);
  for (const variable of ['ACCOUNT_DATABASE_URL', 'ACCESS_DATABASE_URL', 'CONTENT_DATABASE_URL',
    'MAIN_RELAY_DATABASE_URL']) {
    const pool = new Pool({ connectionString: Bun.env[variable] });
    try { expect((await pool.query('SELECT 1 AS ready')).rows[0].ready).toBe(1); }
    finally { await pool.end(); }
  }
});
