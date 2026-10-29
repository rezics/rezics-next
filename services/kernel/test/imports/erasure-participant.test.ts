import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { createPool } from '../../src/database/pool.ts';
import { effectsRelay } from '../../src/events/effects.ts';
import { importsWorkModule } from '../../src/imports/erasure.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { composeWork } from '../../src/work/registry.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { KERNEL_WORK_MODULES } from '../../src/work/modules.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { deletePersona, drainEffects } from '../support/account-deletion.ts';
import { createPersonas, type Persona } from '../support/personas.ts';
import { testKernel } from '../support/test-kernel.ts';

const databaseUrl = process.env.DATABASE_URL!;
const pool = createPool(databaseUrl);
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let person: Persona;
let runtime: Awaited<ReturnType<typeof composeWork>>;
let relay: ReturnType<typeof effectsRelay>;

beforeAll(async () => {
  auth = await nativeFixture(pool);
  const service = auth.host.service;
  const kernel = testKernel({
    pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
  });
  const personas = await createPersonas(kernel, { version: 1, pool, auth });
  person = personas.alice;

  const client = await createWorkClient(databaseUrl, pool);
  runtime = await composeWork([importsWorkModule], { databaseUrl, pool, client });
  await runtime.launch();
  relay = effectsRelay(pool, runtime.effects);
}, 360_000);

afterAll(async () => {
  try {
    await runtime?.shutdown();
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
    'accounts', 'account_erasure', 'rating', 'commerce', 'library', 'community', 'semantic', 'search', 'imports', 'content', 'retention',
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

  await relay.run(partition);
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
  await relay.run(partition);
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
