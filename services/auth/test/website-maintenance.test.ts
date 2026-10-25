import { expect, test } from 'bun:test';
import { testDatabase } from '../scripts/database.ts';

test('protocol retention registers and dispatches one bounded batch through the kernel worker', async () => {
  const fixture = testDatabase();
  // The real SDK has process-global registration. Use a fresh process, the
  // existing kernel composition, and this test's isolated Auth issuer database.
  const program = `
    import assert from 'node:assert/strict';
    import { DBOS } from '@dbos-inc/dbos-sdk';
    import { Pool } from 'pg';
    import { composeWork } from '../kernel/src/work/registry.ts';
    import { createWorkClient } from '../kernel/src/work/client.ts';
    import { websiteMaintenanceModule, WEBSITE_MAINTENANCE_WORKFLOW } from './src/website-maintenance.ts';
    import { pruneExpiredProtocolState } from './src/protocol-maintenance.ts';
    const url = process.env.AUTH_DATABASE_URL;
    await DBOS.migrate(url);
    const pool = new Pool({ connectionString: url });
    const client = await createWorkClient(url, pool);
    let calls = 0;
    const work = await composeWork([websiteMaintenanceModule({
      async pruneExpiredProtocolState(batch) {
        assert.equal(batch, 1000);
        calls++;
        return pruneExpiredProtocolState(pool, batch);
      },
    })], { databaseUrl: url, pool, client });
    assert.equal(DBOS.isInitialized(), false);
    try {
      const schedule = await client.getSchedule(WEBSITE_MAINTENANCE_WORKFLOW);
      assert.equal(schedule.queueName, 'maintenance');
      assert.equal(schedule.automaticBackfill, false);
      await pool.query(\`INSERT INTO "oauthClientAssertion" (id,"expiresAt")
        SELECT 'expired-'||i,now()-interval '1 day' FROM generate_series(1,2001) i\`);
      await work.launch();
      for (const remaining of [1001, 1]) {
        const handle = await client.enqueue({workflowName: WEBSITE_MAINTENANCE_WORKFLOW,
          queueName: 'maintenance'}, new Date(0), null);
        assert.equal(await handle.getResult(), 1000);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM "oauthClientAssertion"')).rows[0].n, remaining);
      }
      assert.equal(calls, 2);
    } finally {
      await work.shutdown();
      await client.close();
      await pool.end();
    }
  `;
  try {
    const child = Bun.spawn([process.execPath, '-e', program], {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, AUTH_DATABASE_URL: fixture.url },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, errors).toBe(0);
  } finally {
    fixture.close();
  }
}, 30000);
