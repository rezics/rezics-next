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
const replies: unknown[] = [];

async function workerRequest(request: 'observe' | 'redeliver') {
  runtime.send(request);
  const deadline = Date.now() + 30_000;
  while (!replies.length && Date.now() < deadline && runtime.exitCode === null) await Bun.sleep(10);
  const reply = replies.shift() as {
    error?: string;
    request: string;
    envelope: { partition: number; epoch: number; position: string; events: unknown[] };
    eventSeq: number;
    workflowId: string;
    status: { workflowID: string; workflowName: string; status: string; input: unknown[] };
    steps: { name: string }[];
  };
  expect(reply).toBeDefined();
  expect(reply.error).toBeUndefined();
  expect(reply.request).toBe(request);
  expect(reply.status).toMatchObject({ workflowID: reply.workflowId, workflowName: 'effect', status: 'SUCCESS' });
  expect(reply.status.input).toEqual(['imports_erasure', reply.envelope.events[reply.eventSeq]]);
  expect(reply.steps.filter((step) => step.name === 'effect.run')).toHaveLength(1);
  return reply;
}

function observeOwners(status: Awaited<ReturnType<typeof readErasureStatus>>) {
  expect(status).not.toBeNull();
  expect(Object.keys(status!.participants)).toHaveLength(11);
  if (Object.values(status!.participants).some((participant) => participant.outcome === 'pending'))
    expect(status!.completedAt).toBeNull();
  // Record every owner's actual result; concurrent acknowledgements belong to that owner.
  console.log('native erasure owners', JSON.stringify(status));
}

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
      IMPORTS_ERASURE_ACCOUNT: person.accountId,
      KERNEL_WORKER_POOL_SIZE: '20',
      KERNEL_EXECUTOR_ID: `imports-erasure-${crypto.randomUUID()}`,
    },
    ipc: (message) => replies.push(message),
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

test('registered imports erasure effect preserves the exact native acknowledgement and workflow identity under actual redelivery without inventing other owners outcomes', async () => {
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

  const eventRows = await pool.query<{
    id: string;
    type: string;
    subject: string;
    data: { accountId: string };
    epoch: number;
    position: string;
    event_seq: number;
  }>(
    `SELECT e.id,e.type,e.subject,e.data,e.epoch,e.position::text,e.event_seq FROM core.outbox e
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
  const first = await workerRequest('observe');
  let delivered = await readErasureStatus(pool, person.accountId);
  for (let attempt = 0; attempt < 100 && delivered?.participants.imports?.outcome === 'pending'; attempt++) {
    await Bun.sleep(10);
    delivered = await readErasureStatus(pool, person.accountId);
  }
  expect(delivered?.participants.imports?.outcome).toBe('none');
  observeOwners(delivered);
  expect(first.envelope.partition).toBe(partition);
  expect(first.workflowId).toBe(
    `fx:${first.envelope.epoch}:${partition}:${first.envelope.position}:${first.eventSeq}:imports_erasure`,
  );
  const committed = eventRows.rows[0]!;
  expect(first.envelope.epoch).toBe(committed.epoch);
  expect(first.envelope.position).toBe(committed.position);
  expect(first.eventSeq).toBe(committed.event_seq);
  expect(first.envelope.events[first.eventSeq]).toMatchObject({
    id: committed.id,
    type: committed.type,
    subject: committed.subject,
    data: committed.data,
  });

  const acknowledgement = await pool.query<{
    acknowledgement: Record<string, unknown>;
    xmin: string;
  }>(
    `SELECT to_jsonb(a) AS acknowledgement,a.xmin::text
     FROM access.erasure_acknowledgement a
     WHERE a.route=$1 AND a.account_id=$2 AND a.participant='imports'`,
    [route, person.accountId],
  );
  expect(acknowledgement.rows).toHaveLength(1);
  expect(acknowledgement.rows[0]?.acknowledgement).toMatchObject({
    outcome: 'none',
    retained: [],
    participant: 'imports',
    account_id: person.accountId,
  });
  const immutableRow = acknowledgement.rows[0];
  const redelivered = await workerRequest('redeliver');
  expect(redelivered.envelope).toEqual(first.envelope);
  expect(redelivered.eventSeq).toBe(first.eventSeq);
  expect(redelivered.workflowId).toBe(first.workflowId);
  expect(redelivered.status).toEqual(first.status);
  expect(redelivered.steps).toEqual(first.steps);
  const replay = await pool.query(
    `SELECT to_jsonb(a) AS acknowledgement,a.xmin::text
     FROM access.erasure_acknowledgement a
     WHERE a.route=$1 AND a.account_id=$2 AND a.participant='imports'`,
    [route, person.accountId],
  );
  expect(replay.rows).toEqual([immutableRow]);
  const final = await readErasureStatus(pool, person.accountId);
  expect(final?.participants.imports?.outcome).toBe('none');
  observeOwners(final);
  expect(deletion.accountId).toBe(person.accountId);
});
