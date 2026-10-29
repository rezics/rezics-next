import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  acknowledgeErasure,
  advanceErasureCompletion,
  ERASURE_LOCATOR_EFFECTS,
  ERASURE_PARTICIPANTS,
  erasureWorkModule,
  readErasureStatus,
  resolveLocatorWork,
} from '../../src/access/erasure.ts';
import { recordLateErasureItem, resolveLateErasureItem } from '../../src/access/index.ts';
import { LifecycleDeniedError } from '../../src/access/lifecycle.ts';
import { runCommand, type CommandTransaction } from '../../src/command/command.ts';
import { effectWorkflowId, relayEffects } from '../../src/events/effects.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { LOCATOR_EFFECTS_QUEUE, WORK_QUEUES } from '../../src/work/queues.ts';
import { composeWork } from '../../src/work/registry.ts';
import { openGrowthDatabase } from '../support/growth.ts';

const locatorEffect = 'test_erasure_locator';
const CREATED = 'com.rezics.subject.created.v1';
const basis = {
  actorAccountId: '00000000-0000-8000-8000-000000000001',
  clientId: 'internal-access',
  requestedBy: null,
};
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let work: Awaited<ReturnType<typeof composeWork>>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
const holds = new Map<
  string,
  { accountId: string; located: ReturnType<typeof barrier>; purge: ReturnType<typeof barrier> }
>();
function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const status = (accountId: string) => readErasureStatus(db.pool, accountId);
const advance = (accountId: string) => advanceErasureCompletion({ pool: db.pool }, accountId);
const record = (
  accountId: string,
  locator: string,
  participant = 'content',
  partition = partitionOf(routeOf(accountId)!),
) =>
  runCommand(db.pool, { partition, basis }, async (tx) => {
    // A participant's fence is held by this same home command transaction.
    await tx.query('SELECT 1 FROM access.account WHERE route=$1 AND account_id=$2 FOR UPDATE', [
      routeOf(accountId),
      accountId,
    ]);
    await recordLateErasureItem(tx, { accountId, participant, locator });
    return {
      value: null,
      events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
    };
  });
const resolve = (accountId: string, locator: string, participant = 'content') =>
  resolveLateErasureItem({ pool: db.pool }, { accountId, participant, locator });

beforeAll(async () => {
  db = await openGrowthDatabase();
  (ERASURE_LOCATOR_EFFECTS as Set<string>).add(locatorEffect);
  await db.admin.query('CREATE TABLE public.erasure_test_copy(id uuid PRIMARY KEY, payload text)');
  client = await createWorkClient(db.url);
  const runtimePool = db.openPool({ max: 10 });
  work = await composeWork(
    [
      erasureWorkModule,
      {
        name: 'test_erasure_participant',
        register(context) {
          context.addEffects([
            {
              name: locatorEffect,
              types: [CREATED],
              async run(event) {
                const locator = (event.data as { id: string }).id;
                const hold = holds.get(locator)!;
                await record(hold.accountId, locator);
                hold.located.release();
                await within(hold.purge.reached, 'copy purge barrier');
                await runCommand(db.pool, { partition: partitionOf(routeOf(locator)!), basis }, async (tx) => {
                  await tx.query('DELETE FROM public.erasure_test_copy WHERE id=$1', [locator]);
                  return {
                    value: null,
                    events: [
                      {
                        type: 'com.rezics.access.account-updated.v1',
                        subject: hold.accountId,
                        data: { accountId: hold.accountId },
                      },
                    ],
                  };
                });
                await resolve(hold.accountId, locator);
              },
            },
            { name: 'test_erasure_other', types: [CREATED], async run() {} },
          ]);
        },
      },
    ],
    { pool: runtimePool, client, databaseUrl: db.url },
  );
  await within(work.launch(), 'work launch');
}, 60000);
afterAll(async () => {
  for (const hold of holds.values()) {
    hold.purge.release();
    await client?.cancelWorkflow(`erasure:${hold.accountId}`);
  }
  if (work) await within(work.shutdown(), 'work shutdown');
  await client?.close();
  (ERASURE_LOCATOR_EFFECTS as Set<string>).delete(locatorEffect);
  await db?.close();
});

async function account(erasure = true) {
  const accountId = newId(0x7351);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    VALUES($1,$2,'actor',$3,$2)`,
    [routeOf(accountId), accountId, erasure ? 'deleted' : 'active'],
  );
  if (erasure)
    await db.admin.query(
      `INSERT INTO access.erasure(route,account_id,version,at)
    VALUES($1,$2,1,clock_timestamp())`,
      [routeOf(accountId), accountId],
    );
  return accountId;
}
async function acknowledgeAll(accountId: string) {
  for (const participant of ERASURE_PARTICIPANTS[1])
    await acknowledgeErasure({ pool: db.pool }, { accountId, participant, outcome: 'none' });
}
async function relayAll() {
  const heads = await db.admin.query('SELECT partition_no FROM core.partition WHERE position>0 ORDER BY partition_no');
  for (const { partition_no } of heads.rows) {
    for (;;) {
      const result = await relayEffects(db.pool, work.effects, partition_no);
      if (result.status !== 'read') throw new Error(`Relay stopped: ${result.status}`);
      if (result.envelopes === 0) break;
    }
  }
}

test('a locator transaction records late work atomically; acknowledgement waits for its committed purge and resolution', async () => {
  const accountId = await account();
  const locator = newId(0x7361);
  await expect(
    runCommand(db.pool, { partition: partitionOf(routeOf(accountId)!), basis }, async (tx) => {
      await recordLateErasureItem(tx, { accountId, participant: 'content', locator });
      throw new Error('rollback locator transaction');
    }),
  ).rejects.toThrow('rollback locator transaction');
  expect((await status(accountId))?.outstanding.lateItems).toBe(false);
  await record(accountId, locator);
  await acknowledgeAll(accountId);
  await relayAll();
  expect((await advance(accountId)).value).toBe(false);
  expect(await status(accountId)).toMatchObject({
    state: 'pending',
    completedAt: null,
    outstanding: { lateItems: true, effectsFrontier: false },
  });
  expect(JSON.stringify(await status(accountId))).not.toContain(locator);
  await resolve(accountId, locator);
  expect((await advance(accountId)).value).toBe(true);
  expect((await status(accountId))?.state).toBe('complete');
}, 180000);

test('record and resolution are idempotent and refuse unknown accounts, participants and items; locators are bounded ids', async () => {
  const accountId = await account();
  const locator = '!'.repeat(255);
  await record(accountId, locator);
  await record(accountId, locator);
  await resolve(accountId, locator);
  const before = await status(accountId);
  const resolved = await resolve(accountId, locator);
  const duplicate = await resolve(accountId, locator);
  expect(duplicate.position).toBe(resolved.position);
  await record(accountId, locator);
  expect(await status(accountId)).toEqual(before);
  expect(
    (await db.admin.query('SELECT 1 FROM access.erasure_late_item WHERE account_id=$1', [accountId])).rowCount,
  ).toBe(1);
  for (const unknown of [await account(false), newId(0x7351)]) {
    await expect(record(unknown, 'id')).rejects.toBeInstanceOf(LifecycleDeniedError);
    await expect(resolve(unknown, 'id')).rejects.toBeInstanceOf(LifecycleDeniedError);
  }
  for (const invalid of ['', 'x'.repeat(256), 'id\n', 'id\t', 'é']) {
    await expect(record(accountId, invalid)).rejects.toBeInstanceOf(LifecycleDeniedError);
    await expect(resolve(accountId, invalid)).rejects.toBeInstanceOf(LifecycleDeniedError);
  }
  await expect(resolve(accountId, 'unknown')).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(record(accountId, 'id', 'unknown')).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(resolve(accountId, locator, 'unknown')).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(record(accountId, 'id', 'content', 0)).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(
    recordLateErasureItem(db.pool as unknown as CommandTransaction, {
      accountId,
      participant: 'content',
      locator: 'id',
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
}, 180000);

test('the undelivered frontier and a held locator effect block durable completion, while routing and partition keys stay unchanged', async () => {
  await relayAll();
  const accountId = await account(false);
  const locator = newId(0x7361);
  const hold = { accountId, located: barrier(), purge: barrier() };
  holds.set(locator, hold);
  const copied = await runCommand(db.pool, { partition: partitionOf(routeOf(locator)!), basis }, async (tx) => {
    await tx.query('INSERT INTO public.erasure_test_copy VALUES($1,$2)', [locator, 'private payload']);
    return { value: locator, events: [{ type: CREATED, data: { id: locator } }] };
  });
  // The relay is held by the test: no delivery call occurs until every participant acknowledges.
  await runCommand(db.pool, { partition: partitionOf(routeOf(accountId)!), basis }, async (tx) => {
    await tx.query("UPDATE access.account SET state='deleted' WHERE route=$1 AND account_id=$2", [
      routeOf(accountId),
      accountId,
    ]);
    await tx.query('INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,clock_timestamp())', [
      routeOf(accountId),
      accountId,
    ]);
    return {
      value: null,
      events: [
        {
          type: 'com.rezics.access.account-tombstoned.v1',
          subject: accountId,
          data: {
            accountId,
            receiptId: newId(0x7351),
            minimumAuthnEpoch: '2',
            kind: 'tombstone',
            priorOperatorAccountId: null,
          },
        },
      ],
    };
  });
  await acknowledgeAll(accountId);
  expect((await advance(accountId)).value).toBe(false);
  expect(await status(accountId)).toMatchObject({
    state: 'pending',
    outstanding: { effectsFrontier: true, lateItems: false },
  });
  await relayAll();
  await within(hold.located.reached, 'locator barrier');
  const envelope = { partition: copied.partition, epoch: copied.epoch, position: copied.position, events: [] };
  const workflowId = effectWorkflowId(envelope, 0, locatorEffect);
  expect(await DBOS.getWorkflowStatus(workflowId)).toMatchObject({
    queueName: LOCATOR_EFFECTS_QUEUE,
    queuePartitionKey: `${locatorEffect}:${copied.partition}`,
    workflowName: 'effect',
  });
  expect(await DBOS.getWorkflowStatus(effectWorkflowId(envelope, 0, 'test_erasure_other'))).toMatchObject({
    queueName: 'effects',
    queuePartitionKey: `test_erasure_other:${copied.partition}`,
  });
  expect(WORK_QUEUES[LOCATOR_EFFECTS_QUEUE]).toEqual(WORK_QUEUES.effects);
  expect((await advance(accountId)).value).toBe(false);
  expect(await status(accountId)).toMatchObject({
    state: 'pending',
    outstanding: { effectsFrontier: true, lateItems: true },
  });
  expect(
    (await db.admin.query('SELECT payload FROM public.erasure_test_copy WHERE id=$1', [locator])).rows[0]?.payload,
  ).toBe('private payload');
  hold.purge.release();
  await within(DBOS.retrieveWorkflow(workflowId).getResult(), 'locator workflow');
  await within(DBOS.retrieveWorkflow(`erasure:${accountId}`).getResult(), 'erasure workflow');
  expect((await status(accountId))?.state).toBe('complete');
  expect((await db.admin.query('SELECT 1 FROM public.erasure_test_copy WHERE id=$1', [locator])).rows).toEqual([]);
}, 30000);

test('the frontier finds non-zero priority pending work and ignores unrelated failed, slow and later workflows', async () => {
  await relayAll();
  const accountId = await account();
  await acknowledgeAll(accountId);
  const pendingId = `priority-locator:${accountId}`;
  await client.enqueue(
    {
      workflowName: 'effect',
      workflowID: pendingId,
      queueName: LOCATOR_EFFECTS_QUEUE,
      priority: 7,
      queuePartitionKey: 'test-priority:0',
      appVersion: 'held-for-test',
    },
    locatorEffect,
    {},
  );
  await db.admin.query(
    `INSERT INTO access.erasure_locator_work(workflow_id,effect,opened_at)
     VALUES($1,$2,0)`,
    [pendingId, locatorEffect],
  );
  await relayAll();
  expect((await advance(accountId)).value).toBe(false);
  expect((await status(accountId))?.outstanding.effectsFrontier).toBe(true);
  await db.admin.query(
    `INSERT INTO dbos.workflow_status(workflow_uuid,name,status,queue_name,created_at)
    VALUES($1,'unrelated','ERROR','effects',0),($2,'unrelated','PENDING','effects',0),
    ($3,'effect','ENQUEUED',$4,9223372036854775807)`,
    [`failed:${accountId}`, `slow:${accountId}`, `later:${accountId}`, LOCATOR_EFFECTS_QUEUE],
  );
  await within(client.cancelWorkflow(pendingId), 'priority cancellation');
  expect((await advance(accountId)).value).toBe(false);
  expect(await status(accountId)).toMatchObject({ state: 'pending', outstanding: { effectsFrontier: true } });
  // Work opened strictly after delivery cannot hold this fixed boundary.
  await db.admin.query(
    `INSERT INTO access.erasure_locator_work(workflow_id,effect,opened_at)
     SELECT $2,$3,workflow_until+1 FROM access.erasure WHERE account_id=$1`,
    [accountId, `later:${accountId}`, locatorEffect],
  );
  await runCommand(db.pool, { partition: partitionOf(routeOf(accountId)!), basis }, async (tx) => {
    await resolveLocatorWork(tx, pendingId);
    return { value: null, events: [{ type: 'com.rezics.access.account-updated.v1', data: { accountId } }] };
  });
  expect((await advance(accountId)).value).toBe(true);
  expect((await status(accountId))?.state).toBe('complete');
  await client.cancelWorkflow(`slow:${accountId}`);
  await client.cancelWorkflow(`later:${accountId}`);
}, 180000);

test('the migration and coordinator issue no DDL in the SDK schema', async () => {
  const migrations = Array.from(
    new Bun.Glob('db/access/migrations/*erasure*.sql').scanSync({ cwd: `${import.meta.dir}/../..` }),
  );
  for (const path of migrations)
    expect(await Bun.file(`${import.meta.dir}/../../${path}`).text()).not.toMatch(
      /(?:CREATE|ALTER|DROP)\s+(?:INDEX|TABLE|SCHEMA)[\s\S]*?\bdbos\./i,
    );
});
