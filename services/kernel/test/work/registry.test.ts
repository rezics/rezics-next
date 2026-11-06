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

test('worker authorization is lazy, shared across modules and does not add a DBOS launch', async () => {
  const program = `
    import assert from 'node:assert/strict';
    import { DBOS } from '@dbos-inc/dbos-sdk';
    import pg from 'pg';
    import { composeWork } from './src/work/registry.ts';
    import { WORK_QUEUES } from './src/work/queues.ts';

    const pool = new pg.Pool();
    const noIO = () => { throw new Error('Unexpected composition I/O'); };
    pool.connect = noIO;
    pool.query = noIO;
    let launches = 0;
    DBOS.launch = async () => { launches++; };
    DBOS.shutdown = async () => {};
    const queues = [];
    const client = { async registerQueue(name) { queues.push(name); } };
    const env = {};
    const receiptKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
    let authorization;
    let getAuthorization;
    const work = await composeWork([
      { name: 'no-authorization', register(context) {
        // No configuration is required until a module actually needs Access.
        assert.equal(context.client, client);
        assert.equal(context.pool, pool);
        Object.assign(env, {
          KERNEL_ROUTE_KEY: Buffer.alloc(32, 1).toString('base64url'),
          KERNEL_SESSION_KEYS: '1:' + Buffer.alloc(32, 2).toString('base64url'),
          AUTH_ISSUER: 'https://worker-auth.test',
          AUTH_AUDIENCE: 'https://worker-api.test',
          AUTH_JWKS_URL: 'https://worker-auth.test/jwks',
        });
      } },
      { name: 'first-consumer', register(context) {
        authorization = context.getAuthorization();
        getAuthorization = context.getAuthorization;
        assert.equal(typeof authorization.readConsent, 'function');
      } },
      { name: 'second-consumer', register(context) {
        env.CF_ACCESS_CLIENT_ID = 'invalid-if-reread';
        assert.equal(context.getAuthorization(), authorization);
      } },
    ], { databaseUrl: 'postgres://unused/worker', pool, client, env, receiptKeys });
    assert.deepEqual(queues, Object.keys(WORK_QUEUES));
    assert.equal(getAuthorization(), authorization);
    assert.equal(launches, 0);
    await Promise.all([work.launch(), work.launch()]);
    assert.equal(launches, 1);
    await work.shutdown();
    await pool.end();
    console.log('authorization-registry-ok');
  `;
  const child = Bun.spawn([process.execPath, '-e', program], {
    cwd: new URL('../..', import.meta.url).pathname,
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
  expect(output).toContain('authorization-registry-ok');
}, 30_000);
