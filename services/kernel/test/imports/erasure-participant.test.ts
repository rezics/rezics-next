import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { createPool } from '../../src/database/pool.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { importsWorkModule } from '../../src/imports/erasure.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { KERNEL_WORK_MODULES } from '../../src/work/modules.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { deletePersona, drainEffects } from '../support/account-deletion.ts';
import { createPersonas, type Persona } from '../support/personas.ts';
import { testKernel } from '../support/test-kernel.ts';

const databaseUrl = process.env.DATABASE_URL!;
const pool = createPool(databaseUrl);
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let person: Persona;
let runtime: ReturnType<typeof Bun.spawn>;
let workerOutput = '';
let workerRead: Promise<void>;
let workerErrors: Promise<string>;

beforeAll(async () => {
  auth = await nativeFixture(pool);
  const service = auth.host.service;
  const kernel = testKernel({
    pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({
      secret: 'imports-erasure-native-write-secret',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
    }),
  });
  const personas = await createPersonas(kernel, { version: 1, pool, auth });
  person = personas.alice;
}, 360_000);

async function startImportsWorker() {
  runtime = Bun.spawn([process.execPath, `${import.meta.dir}/erasure-participant-worker.ts`], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      KERNEL_WORKER_POOL_SIZE: '4',
      KERNEL_EXECUTOR_ID: `imports-erasure-${crypto.randomUUID()}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (!(runtime.stdout instanceof ReadableStream) || !(runtime.stderr instanceof ReadableStream))
    throw new Error('Imports worker streams are unavailable');
  const stdout = runtime.stdout;
  const stderr = runtime.stderr;
  workerRead = (async () => {
    for await (const chunk of stdout) workerOutput += new TextDecoder().decode(chunk);
  })();
  workerErrors = new Response(stderr).text();
  const deadline = Date.now() + 30_000;
  while (!workerOutput.includes('imports-worker-ready') && Date.now() < deadline && runtime.exitCode === null)
    await Bun.sleep(10);
  expect(workerOutput).toContain('imports-worker-ready');
}

afterAll(async () => {
  try {
    if (runtime) {
      runtime.kill('SIGTERM');
      await runtime.exited;
      await workerRead;
      expect(await workerErrors).toBe('');
    }
  } finally {
    try {
      await auth?.close();
    } finally {
      await pool.end();
    }
  }
});

test('real account deletion delivers the registered imports effect and persists a truthful immutable none acknowledgement', async () => {
  expect(KERNEL_WORK_MODULES.filter((module) => module === importsWorkModule)).toHaveLength(1);
  expect(KERNEL_WORK_MODULES.map((module) => module.name)).toEqual([
    'accounts',
    'account_erasure',
    'rating',
    'commerce',
    'library',
    'community',
    'semantic',
    'search',
    'imports',
    'content',
    'retention',
  ]);

  const deletion = await deletePersona({ version: 1, pool, auth }, person);
  const route = routeOf(person.accountId)!;
  const partition = partitionOf(route);
  const before = await readErasureStatus(pool, person.accountId);
  expect(before?.participants.imports?.outcome).toBe('pending');
  expect(before?.completedAt).toBeNull();

  const eventRows = await pool.query<{ type: string; subject: string; data: { accountId: string } }>(
    `SELECT e.type,e.subject,e.data FROM core.outbox e
     WHERE e.partition_no=$1 AND e.type='com.rezics.access.account-tombstoned.v1'
       AND e.subject=$2 ORDER BY e.position DESC LIMIT 1`,
    [partition, person.accountId],
  );
  expect(eventRows.rows).toHaveLength(1);
  expect(eventRows.rows[0]).toMatchObject({
    type: 'com.rezics.access.account-tombstoned.v1',
    subject: person.accountId,
    data: { accountId: person.accountId },
  });

  await startImportsWorker();
  await drainEffects(pool, partition);
  let delivered = await readErasureStatus(pool, person.accountId);
  for (let attempt = 0; attempt < 100 && delivered?.participants.imports?.outcome === 'pending'; attempt++) {
    await Bun.sleep(10);
    delivered = await readErasureStatus(pool, person.accountId);
  }
  expect(delivered?.participants.imports?.outcome).toBe('none');
  expect(delivered?.participants.access?.outcome).toBe('pending');
  expect(delivered?.participants.auth?.outcome).toBe('pending');
  expect(delivered?.completedAt).toBeNull();

  const acknowledgement = await pool.query<{
    outcome: string;
    retained: unknown;
    xmin: string;
  }>(
    `SELECT a.outcome,a.retained,a.xmin::text
     FROM access.erasure_acknowledgement a
     WHERE a.route=$1 AND a.account_id=$2 AND a.participant='imports'`,
    [route, person.accountId],
  );
  expect(acknowledgement.rows).toHaveLength(1);
  expect(acknowledgement.rows[0]).toMatchObject({ outcome: 'none', retained: [] });
  const immutableRow = acknowledgement.rows[0];
  const replay = await pool.query(
    `SELECT a.outcome,a.retained,a.xmin::text
     FROM access.erasure_acknowledgement a
     WHERE a.route=$1 AND a.account_id=$2 AND a.participant='imports'`,
    [route, person.accountId],
  );
  expect(replay.rows).toEqual([immutableRow]);
  expect((await readErasureStatus(pool, person.accountId))?.participants.imports?.outcome).toBe('none');
  expect(deletion.accountId).toBe(person.accountId);
});
