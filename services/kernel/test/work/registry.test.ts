import { expect, test } from 'bun:test';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { fixture } from './support/process.ts';

// The subprocess constructs the native kernel SQL graph before registration. Allow one minute for that startup,
// then a separate 30 s budget for each of its two queued workflows and for draining the runtime.
const registryTimeout = 60_000 + 2 * 30_000 + 30_000;

test('the queue set is exactly ADR-0033, with reserved governance concurrency and source partitions', () => {
  expect(Object.keys(WORK_QUEUES)).toEqual([
    'governance',
    'effects',
    'locator-effects',
    'workflows',
    'delivery',
    'import',
    'maintenance',
  ]);
  expect(WORK_QUEUES.governance.workerConcurrency).toBeGreaterThan(0);
  expect(WORK_QUEUES.import.partitionConcurrency).toBeGreaterThan(0);
});

test(
  'queues register once before ordered modules and one launch; duplicate and late registration fail',
  async () => {
    const runtime = fixture('registry');
    try {
      expect(await runtime.finish()).toContain('registry-ok');
    } finally {
      runtime.child.kill();
    }
  },
  registryTimeout,
);

test('a module receives the environment supplied to work composition', async () => {
  const program = `
    import assert from 'node:assert/strict';
    import pg from 'pg';
    import { composeWork } from './src/work/registry.ts';

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const env = { COMPOSITION_VALUE: 'registration-only' };
    let received;
    await composeWork(
      [{ name: 'environment', register(context) { received = context.env; } }],
      {
        databaseUrl: process.env.DATABASE_URL,
        pool,
        client: { async registerQueue() {} },
        env,
      },
    );
    assert.deepEqual(received, env);
    await pool.end();
    console.log('environment-ok');
  `;
  const child = Bun.spawn([process.execPath, '-e', program], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, errors).toBe(0);
  expect(output).toContain('environment-ok');
}, 30_000);
