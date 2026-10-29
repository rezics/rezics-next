import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  acknowledgeErasure,
  advanceErasureCompletion,
  ERASURE_LOCATOR_EFFECTS,
  ERASURE_PARTICIPANTS,
  readErasureStatus,
  resolveLocatorWork,
} from '../../src/access/erasure.ts';
import { authoritativeTimeValue, runCommand } from '../../src/command/command.ts';
import { effectWorkflowId, relayEffects } from '../../src/events/effects.ts';
import type { Envelope } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { runWorkflowRetentionSweep } from '../../src/work/retention.ts';
import { openGrowthDatabase } from '../support/growth.ts';

const locator = 'failed_locator_test';
const other = 'failed_other_test';
const CREATED = 'com.rezics.subject.created.v1';
const CONTEXT = 'com.rezics.semantic.context.created.v1';
const basis = {
  actorAccountId: '00000000-0000-8000-8000-000000000001',
  clientId: 'internal-access',
  requestedBy: null,
};
function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}
type Control = {
  entered: ReturnType<typeof barrier>;
  gate: ReturnType<typeof barrier>;
  fail: boolean;
  attempts: number;
};
const controls = new Map<string, Control>();
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
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let work: Awaited<ReturnType<typeof composeWork>>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let nextPartition = 1800;
const advance = (id: string) => advanceErasureCompletion({ pool: db.pool }, id);
const status = (id: string) => readErasureStatus(db.pool, id);
async function row(id: string) {
  return (await db.admin.query('SELECT * FROM access.erasure_locator_work WHERE workflow_id=$1', [id])).rows[0];
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  client = await createWorkClient(db.url);
  (ERASURE_LOCATOR_EFFECTS as Set<string>).add(locator);
  const originalStep = DBOS.registerStep.bind(DBOS);
  // Keep the real durable step and all ten attempts, shortening only the test's retry clock.
  const retryClock = spyOn(DBOS, 'registerStep').mockImplementation(((
    ...args: Parameters<typeof DBOS.registerStep>
  ) => {
    const [fn, options] = args;
    return originalStep(
      fn,
      options?.name === 'effect.run' ? { ...options, intervalSeconds: 0.001, backoffRate: 1 } : options,
    );
  }) as never);
  try {
    work = await composeWork(
      [
        {
          name: 'failed_locator_fixture',
          register(context) {
            context.addEffects(
              [locator, other].map((name) => ({
                name,
                types: [name === locator ? CREATED : CONTEXT],
                async run(event) {
                  const control = controls.get((event.data as { id: string }).id)!;
                  control.attempts++;
                  control.entered.release();
                  await within(control.gate.reached, 'effect barrier');
                  if (control.fail) throw new Error('deterministic locator failure');
                },
              })),
            );
          },
        },
      ],
      { pool: db.openPool({ max: 10 }), client, databaseUrl: db.url },
    );
  } finally {
    retryClock.mockRestore();
  }
  await within(work.launch(), 'work launch');
}, 180000);

afterAll(async () => {
  for (const control of controls.values()) {
    control.fail = false;
    control.gate.release();
  }
  if (work) await within(work.shutdown(), 'work shutdown');
  if (client) await within(client.close(), 'work client close');
  (ERASURE_LOCATOR_EFFECTS as Set<string>).delete(locator);
  if (db) await within(db.close(), 'database close');
});

async function source(options: { fail?: boolean; held?: boolean; partition?: number; other?: boolean } = {}) {
  const id = newId(0x7351);
  const control: Control = { entered: barrier(), gate: barrier(), fail: options.fail ?? false, attempts: 0 };
  controls.set(id, control);
  if (!options.held) control.gate.release();
  const result = await runCommand(db.pool, { partition: options.partition ?? nextPartition++, basis }, async () => ({
    value: id,
    events: [{ type: options.other ? CONTEXT : CREATED, data: { id } }],
  }));
  const envelope: Envelope = { ...result, events: [] };
  return { ...result, control, workflowId: effectWorkflowId(envelope, 0, options.other ? other : locator) };
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
async function tombstone() {
  const accountId = newId(0x7351);
  const route = routeOf(accountId)!;
  await runCommand(db.pool, { partition: partitionOf(route), basis }, async (tx, { time }) => {
    await tx.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
      VALUES($1,$2,'actor','deleted',$2)`,
      [route, accountId],
    );
    // SQL preserves full authoritative precision, as the lifecycle command does.
    await tx.query('INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,$3)', [
      route,
      accountId,
      authoritativeTimeValue(time),
    ]);
    return { value: null, events: [{ type: 'com.rezics.access.account-updated.v1', data: { accountId } }] };
  });
  for (const participant of ERASURE_PARTICIPANTS[1])
    await acknowledgeErasure({ pool: db.pool }, { accountId, participant, outcome: 'none' });
  await relayAll();
  await advance(accountId);
  return accountId;
}
async function resolve(workflowId: string, accountId: string) {
  return runCommand(db.pool, { partition: partitionOf(routeOf(accountId)!), basis }, async (tx) => {
    await resolveLocatorWork(tx, workflowId);
    return { value: null, events: [{ type: 'com.rezics.access.account-updated.v1', data: { accountId } }] };
  });
}
async function expectHeld(accountId: string) {
  expect((await advance(accountId)).value).toBe(false);
  expect(await status(accountId)).toMatchObject({
    state: 'pending',
    completedAt: null,
    outstanding: { lateItems: false, effectsFrontier: true },
  });
}

test('ERROR holds every subsequent erasure, survives resume and a successful fork, and clears only by named platform resolution', async () => {
  const failed = await source({ fail: true });
  await relayAll();
  await expect(within(DBOS.retrieveWorkflow(failed.workflowId).getResult(), 'failed workflow')).rejects.toThrow();
  expect(failed.control.attempts).toBe(10);
  expect(await within(DBOS.getWorkflowStatus(failed.workflowId), 'workflow status')).toMatchObject({ status: 'ERROR' });
  expect(await row(failed.workflowId)).toMatchObject({ state: 'open', effect: locator });
  const accounts = [await tombstone(), await tombstone()];
  for (const accountId of accounts) {
    await expectHeld(accountId);
    const erasure = (
      await db.admin.query('SELECT frontier,workflow_until FROM access.erasure WHERE account_id=$1', [accountId])
    ).rows[0];
    expect(erasure.frontier.some((head: { partition: number }) => head.partition === failed.partition)).toBe(false);
    expect(BigInt((await row(failed.workflowId)).opened_at)).toBeLessThanOrEqual(BigInt(erasure.workflow_until));
  }
  failed.control.fail = false;
  await within(DBOS.resumeWorkflow(failed.workflowId), 'ERROR resume');
  expect(await within(DBOS.getWorkflowStatus(failed.workflowId), 'workflow status')).toMatchObject({ status: 'ERROR' });
  const forkId = `fork:${failed.workflowId}`;
  await within(
    (await within(DBOS.forkWorkflow(failed.workflowId, 0, { newWorkflowID: forkId }), 'fork enqueue')).getResult(),
    'fork result',
  );
  expect(await within(DBOS.getWorkflowStatus(forkId), 'workflow status')).toMatchObject({ status: 'SUCCESS' });
  expect(await row(failed.workflowId)).toMatchObject({ state: 'open' });
  for (const accountId of accounts) await expectHeld(accountId);
  const resolution = await resolve(failed.workflowId, accounts[0]!);
  expect(await row(failed.workflowId)).toMatchObject({
    state: 'resolved',
    resolution_transaction_id: resolution.transactionId,
  });
  await relayAll();
  for (const accountId of accounts) expect((await advance(accountId)).value).toBe(true);
  // Replay of a resolved origin cannot reopen it, even though its DBOS result remains ERROR.
  await db.admin.query("UPDATE core.consumer_checkpoint SET position=0 WHERE consumer='effects' AND partition_no=$1", [
    failed.partition,
  ]);
  await relayAll();
  expect((await row(failed.workflowId)).state).toBe('resolved');
}, 180000);

test('retention deletes failed DBOS history before the first tombstone without losing custody evidence', async () => {
  const failed = await source({ fail: true });
  await relayAll();
  await expect(
    within(DBOS.retrieveWorkflow(failed.workflowId).getResult(), 'retained failed workflow'),
  ).rejects.toThrow();
  const old = Date.now() - 40 * 86400000;
  await db.admin.query('UPDATE dbos.workflow_status SET created_at=$2,completed_at=$2 WHERE workflow_uuid=$1', [
    failed.workflowId,
    old,
  ]);
  expect(await runWorkflowRetentionSweep(30, client)).toBe(1);
  expect(await client.getWorkflow(failed.workflowId)).toBeUndefined();
  const accountId = await tombstone();
  await expectHeld(accountId);
  const json = JSON.stringify(await status(accountId));
  expect(json).not.toContain(failed.value);
  expect(json).not.toContain(failed.workflowId);
  await resolve(failed.workflowId, accountId);
  await relayAll();
  expect((await advance(accountId)).value).toBe(true);
}, 180000);

for (const ending of ['CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'] as const) {
  test(`${ending} before the first step holds erasure and same-id resume runs the durable done step`, async () => {
    const partition = nextPartition++;
    const head = await source({ held: true, partition });
    await relayAll();
    await within(head.control.entered.reached, 'head effect barrier');
    const queued = await source({ partition });
    await relayAll();
    expect(await within(DBOS.getWorkflowStatus(queued.workflowId), 'workflow status')).toMatchObject({
      status: 'ENQUEUED',
    });
    await within(DBOS.cancelWorkflow(queued.workflowId), 'workflow cancellation');
    expect(queued.control.attempts).toBe(0);
    if (ending === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED') {
      // Install the SDK's exhausted-recovery terminal state; resume itself uses the real installed SDK.
      await db.admin.query('UPDATE dbos.workflow_status SET status=$2 WHERE workflow_uuid=$1', [
        queued.workflowId,
        ending,
      ]);
    }
    head.control.gate.release();
    await within(DBOS.retrieveWorkflow(head.workflowId).getResult(), 'head workflow');
    const accountId = await tombstone();
    await expectHeld(accountId);
    await within(
      (await within(DBOS.resumeWorkflow(queued.workflowId), 'resume enqueue')).getResult(),
      'resumed workflow',
    );
    expect(queued.control.attempts).toBe(1);
    expect(await row(queued.workflowId)).toMatchObject({ state: 'done', resolution_transaction_id: null });
    const steps = await within(DBOS.listWorkflowSteps(queued.workflowId), 'workflow steps');
    expect(steps?.map((step) => step.name)).toContain('effect.locator.done');
    await within(DBOS.resumeWorkflow(queued.workflowId), 'successful workflow resume');
    expect(await within(DBOS.getWorkflowStatus(queued.workflowId), 'workflow status')).toMatchObject({
      status: 'SUCCESS',
    });
    expect(queued.control.attempts).toBe(1);
    expect((await advance(accountId)).value).toBe(true);
    await db.admin.query(
      "UPDATE core.consumer_checkpoint SET position=0 WHERE consumer='effects' AND partition_no=$1",
      [partition],
    );
    await relayAll();
    expect((await row(queued.workflowId)).state).toBe('done');
  }, 180000);
}

test('later open locator work and an unregistered failed effect do not hold an earlier tombstone', async () => {
  const unregistered = await source({ fail: true, other: true });
  await relayAll();
  await expect(
    within(DBOS.retrieveWorkflow(unregistered.workflowId).getResult(), 'unregistered failed workflow'),
  ).rejects.toThrow();
  expect(await row(unregistered.workflowId)).toBeUndefined();
  const accountId = await tombstone();
  const later = await source({ held: true });
  await relayAll();
  await within(later.control.entered.reached, 'later effect barrier');
  expect((await row(later.workflowId)).state).toBe('open');
  expect((await status(accountId))?.state).toBe('complete');
  // Re-evaluate an uncompleted erasure at the same T to exercise the probe rather than the completed shortcut.
  const twin = newId(0x7351);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    VALUES($1,$2,'actor','deleted',$2)`,
    [routeOf(twin), twin],
  );
  await db.admin.query(
    `INSERT INTO access.erasure(route,account_id,version,at,frontier,workflow_until)
    SELECT route,$2,version,at,'[]'::jsonb,workflow_until FROM access.erasure WHERE account_id=$1`,
    [accountId, twin],
  );
  for (const participant of ERASURE_PARTICIPANTS[1])
    await acknowledgeErasure({ pool: db.pool }, { accountId: twin, participant, outcome: 'none' });
  expect((await status(twin))?.state).toBe('complete');
  later.control.gate.release();
  await within(DBOS.retrieveWorkflow(later.workflowId).getResult(), 'later workflow');
}, 180000);

test('all batch rows commit before enqueue; an enqueue failure leaves the checkpoint behind and replay preserves success', async () => {
  const partition = nextPartition++;
  const first = await source({ held: true, partition });
  const second = await source({ partition });
  const originalStart = DBOS.startWorkflow.bind(DBOS) as (
    fn: (...args: unknown[]) => Promise<unknown>,
    options?: Parameters<typeof DBOS.startWorkflow>[1],
  ) => (...args: unknown[]) => Promise<unknown>;
  let starts = 0;
  const failure = spyOn(DBOS, 'startWorkflow').mockImplementation(((...args: Parameters<typeof originalStart>) => {
    const start = originalStart(...args);
    return async (...inputs: unknown[]) => {
      expect((await row(first.workflowId)).state).toBe('open');
      expect((await row(second.workflowId)).state).toBe('open');
      if (++starts === 2) throw new Error('test enqueue failure');
      return start(...inputs);
    };
  }) as never);
  try {
    await expect(relayEffects(db.pool, work.effects, partition)).rejects.toThrow('test enqueue failure');
  } finally {
    failure.mockRestore();
  }
  expect(
    (
      await db.admin.query(
        "SELECT position::text FROM core.consumer_checkpoint WHERE consumer='effects' AND partition_no=$1",
        [partition],
      )
    ).rows[0]?.position,
  ).toBe('0');
  first.control.gate.release();
  await within(DBOS.retrieveWorkflow(first.workflowId).getResult(), 'first batch workflow');
  await relayAll();
  await within(DBOS.retrieveWorkflow(second.workflowId).getResult(), 'second batch workflow');
  expect((await row(first.workflowId)).state).toBe('done');
  expect((await row(second.workflowId)).state).toBe('done');
  expect(first.control.attempts).toBe(1);
  expect(
    (
      await db.admin.query(
        "SELECT position::text FROM core.consumer_checkpoint WHERE consumer='effects' AND partition_no=$1",
        [partition],
      )
    ).rows[0]?.position,
  ).toBe(second.position.toString());
}, 180000);
