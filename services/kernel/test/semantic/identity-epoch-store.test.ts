import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { writeSubject } from '../../src/semantic/subject.ts';
import type { IdentityIntent, IdentityJobRef, IdentityReceipt } from '../../src/semantic/identity-epoch-contract.ts';
import { identityEpochStore as store } from '../../src/semantic/identity-epoch-store.ts';
import { readIdentityEpochCutover, stepIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap.ts';
import {
  digest,
  epochFixture,
  globalResource,
  home,
  release,
  seedLegacyGroup,
  type EpochFixture,
} from './support/identity-epoch.ts';

let f: EpochFixture;
beforeAll(async () => {
  f = await epochFixture();
});
afterAll(async () => {
  await f?.close();
});

async function admission(intent: IdentityIntent, key = randomUUID(), receiptDigest = digest(key)) {
  const actor = await f.actor();
  const receipt: IdentityReceipt = {
    kind: 'subject.merge',
    command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: receiptDigest },
  };
  const execute = async (next = intent, persona: 'editor' | 'outsider' = 'editor') => {
    const current = await f.actor(persona);
    return runCommand(
      f.pool,
      {
        partition: store.controlPartition,
        basis: { actorAccountId: current.accountId, clientId: current.clientId, requestedBy: current.requestedBy },
        authorization: await f.authorization('subject:merge', persona),
      },
      (tx) => store.admit(tx, { intent: next, receipt }),
    );
  };
  return { execute, receipt };
}

async function bootstrapHome(partition: number) {
  for (let page = 0; page < 100; page++) {
    const progress = await stepIdentityEpochBootstrap(f.pool, partition);
    expect(progress.work.rows).toBeLessThanOrEqual(100);
    expect(progress.work.statements).toBeGreaterThan(0);
    expect(progress.work.bytes).toBeGreaterThan(0);
    expect(progress.native.transactionId).toBeString();
    if (page < 2 || progress.state === 'caught-up') {
      console.info(
        'native identity bootstrap observation',
        JSON.stringify({
          partition,
          generation: progress.generation.toString(),
          state: progress.state,
          work: progress.work,
          native: { ...progress.native, position: progress.native.position.toString() },
        }),
      );
    }
    if (progress.state === 'caught-up') return;
  }
  throw new Error('Bounded bootstrap did not finish the finite fixture');
}

async function requireCutover(ids: string[]) {
  for (const partition of new Set(ids.map(home))) await bootstrapHome(partition);
  // No test setter, direct readiness SQL or fabricated participant receipt is permitted here.
  expect(
    await store.readEpoch(f.pool),
    'MISSING actual creation/structural writer cutover hooks; staged legacy pages cannot authorize admission',
  ).toMatchObject({ state: 'published' });
}

async function storeSnapshot(ids: string[]) {
  return {
    legacy: await f.snapshot(ids),
    native: (
      await f.admin.query(`SELECT
      (SELECT jsonb_agg(c) FROM semantic.identity_epoch_control c) control,
      (SELECT count(*)::text FROM semantic.identity_epoch_job) jobs,
      (SELECT count(*)::text FROM semantic.identity_epoch_change) changes,
      (SELECT count(*)::text FROM semantic.identity_epoch_step) steps,
      (SELECT count(*)::text FROM semantic.identity_epoch_ack) acks`)
    ).rows[0],
  };
}

test('native identity store admits one capped durable job with no early publication and idempotent authorized receipt', async () => {
  const survivor = (await f.create()).subject.id;
  const redirected = (await f.create()).subject.id;
  const inherited = await seedLegacyGroup(f, redirected, 200);
  await requireCutover([survivor, redirected]);
  const intent = { kind: 'merge' as const, survivor, redirected, release: release.digest };
  const { execute, receipt } = await admission(intent);
  const before = await store.readEpoch(f.pool);
  const admitted = await execute();
  const job = admitted.value;
  expect(await store.readEpoch(f.pool)).toEqual({
    state: 'pending',
    publishedEpoch: before.state === 'published' ? before.epoch : -1n,
    job,
  });
  expect((await execute()).value).toEqual(job);
  expect((await store.findJob(f.pool, receipt))?.ref).toEqual(job);
  await expect(execute({ ...intent, survivor: redirected })).rejects.toMatchObject({
    name: 'IdempotencyConflictError',
  });
  await expect((await admission(intent)).execute()).rejects.toMatchObject({ code: 'identity_epoch_busy' });
  const changes: string[] = [];
  let after: string | null = null;
  do {
    const page = await store.pageChanges(f.pool, job, after);
    expect(page.changes.length).toBeLessThanOrEqual(100);
    expect(page.changes.every((change) => after === null || change.original > after)).toBe(true);
    changes.push(...page.changes.map((change) => change.original));
    after = page.next;
  } while (after !== null);
  expect(changes).toEqual([survivor, redirected, ...inherited].sort());
  const stable = await store.pageChanges(f.pool, job, null);
  expect(await store.pageChanges(f.pool, job, null)).toEqual(stable);
  await expect(
    runCommand(f.pool, { partition: store.controlPartition }, (tx) => store.publish(tx, job)),
  ).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
  const snapshot = await storeSnapshot([survivor, redirected]);
  await f.real.revoke(globalResource, 'editor', 'subject:merge');
  try {
    await expect(execute()).rejects.toThrow('Denied subject:merge');
    expect(await storeSnapshot([survivor, redirected])).toEqual(snapshot);
  } finally {
    await f.real.grant(globalResource, 'editor', 'subject:merge');
  }
});

test('cap4096 is checked against complete legacy groups before every durable admission effect', async () => {
  const survivor = (await f.create()).subject.id;
  const redirected = (await f.create()).subject.id;
  const left = await seedLegacyGroup(f, survivor, 2047);
  const right = await seedLegacyGroup(f, redirected, 2048);
  await requireCutover([survivor, redirected]);
  const ids = [survivor, redirected, ...left, ...right];
  const before = await storeSnapshot(ids);
  await expect(
    (await admission({ kind: 'merge', survivor, redirected, release: release.digest })).execute(),
  ).rejects.toMatchObject({ code: 'identity_group_overflow' });
  expect(await storeSnapshot(ids)).toEqual(before);
});

test('bounded bootstrap never infers self or readiness from absent mapping', async () => {
  const original = (await f.create('Legacy original without a creation hook', 0x5e10)).subject.id;
  const members = await seedLegacyGroup(f, original, 101);
  expect(await store.readMapping(f.pool, original)).toEqual({ state: 'unavailable', reason: 'bootstrap' });
  expect(await store.readMapping(f.pool, newId(0x5e10))).toEqual({ state: 'absent' });
  const first = await stepIdentityEpochBootstrap(f.pool, home(original));
  expect(first.work.rows).toBeLessThanOrEqual(100);
  await bootstrapHome(home(original));
  const group = (
    await f.admin.query('SELECT observed_count::text FROM semantic.identity_epoch_group WHERE terminal=$1', [original])
  ).rows[0];
  expect(group.observed_count).toBe('102');
  expect(
    (await f.admin.query('SELECT count(*)::text n FROM semantic.identity_epoch_original WHERE terminal=$1', [original]))
      .rows[0].n,
  ).toBe('102');
  expect(await store.readEpoch(f.pool)).toEqual({ state: 'unavailable', reason: 'bootstrap' });
  expect((await readIdentityEpochCutover(f.pool)).missingWriters).toContain('semantic/subject.ts:writeSubject');
  // A create after the scan, and a redirect at an already visited key, must enter maintained dirty work.
  const concurrent = (await f.create('Concurrent legacy create', 0x5e10)).subject.id;
  const survivor = (await f.create('Concurrent destination', 0x5e10)).subject.id;
  await f.merge(concurrent, survivor);
  await bootstrapHome(home(original));
  expect(
    (await f.admin.query('SELECT terminal FROM semantic.identity_epoch_original WHERE original=$1', [concurrent]))
      .rows[0].terminal,
  ).toBe(survivor);
  expect(await store.readMapping(f.pool, members[0]!)).toEqual({ state: 'unavailable', reason: 'bootstrap' });
  const before = await storeSnapshot([original]);
  await expect(
    (await admission({ kind: 'merge', survivor: original, redirected: concurrent, release: release.digest })).execute(),
  ).rejects.toMatchObject({ code: 'identity_epoch_unavailable' });
  expect(await storeSnapshot([original])).toEqual(before);
});

test('same native creation transaction initializes exact self and rolls back with the source', async () => {
  const original = newId(0x5f10);
  const actor = await f.actor();
  const options = {
    partition: home(original),
    basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
    authorization: await f.authorization('subject:create'),
  };
  const create = async (rollback: boolean) =>
    runCommand(f.pool, options, async (tx, { transactionId }) => {
      const result = await writeSubject(tx, transactionId, {
        target: { route: routeOf(original)!, id: original },
        item: { type: 'schema:Person', labels: { en: 'Exact self creation' } },
        release,
      });
      await store.initializeSubject(tx, original);
      if (rollback) throw new Error('rollback exact self');
      return result;
    });
  await expect(create(true)).rejects.toThrow('rollback exact self');
  expect(await store.readMapping(f.pool, original)).toEqual({ state: 'absent' });
  await create(false);
  expect(await store.readMapping(f.pool, original)).toMatchObject({ state: 'mapped', original, terminal: original });
  await expect(
    runCommand(f.pool, options, async (tx) => {
      await store.initializeSubject(tx, original);
      return noEffect(null);
    }),
  ).rejects.toThrow('same native creation transaction');
  await expect(store.initializeSubject(f.pool, original)).rejects.toThrow('No authorized live command');
});

test('stale home effect and fabricated step receipt cannot publish identity epoch', async () => {
  const original = (await f.create('Unhooked original', 0x6010)).subject.id;
  const destination = (await f.create('Wrong destination', 0x6020)).subject.id;
  const job: IdentityJobRef = { jobId: randomUUID(), epoch: 1n };
  const before = await storeSnapshot([original, destination]);
  await expect(
    runCommand(f.pool, { partition: home(destination) }, async (tx) => {
      await store.admitHomeEffect(tx, { kind: 'follow-count', original, terminal: destination, epoch: 0n });
      return noEffect(null);
    }),
  ).rejects.toMatchObject({ code: 'identity_effect_stale' });
  await expect(
    runCommand(f.pool, { partition: home(original) }, async (tx) => {
      await store.admitHomeEffect(tx, { kind: 'structural', original, job });
      return noEffect(null);
    }),
  ).rejects.toMatchObject({ code: 'identity_effect_stale' });
  const noEffectOutcome = await runCommand(f.pool, { partition: home(original) }, async () => noEffect(null));
  for (const native of [
    noEffectOutcome,
    { ...noEffectOutcome, transactionId: randomUUID() },
    { ...noEffectOutcome, partition: home(destination) },
  ]) {
    await expect(
      store.reconcileStepReceipt(f.pool, { job, step: 'search-canonical-index', version: 1, native }),
    ).rejects.toMatchObject({ code: 'identity_step_receipt_invalid' });
  }
  await expect(
    runCommand(f.pool, { partition: store.controlPartition }, (tx) => store.publish(tx, job)),
  ).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
  expect(await storeSnapshot([original, destination])).toEqual(before);
  const missingHomeId = newId(0xfff0);
  const missingOwner = (
    await f.admin.query('DELETE FROM core.partition WHERE partition_no=$1 RETURNING *', [home(missingHomeId)])
  ).rows[0];
  try {
    expect(await store.readMapping(f.pool, missingHomeId)).toEqual({ state: 'unavailable', reason: 'missing-owner' });
  } finally {
    await f.admin.query(
      'INSERT INTO core.partition SELECT * FROM jsonb_populate_record(NULL::core.partition,$1::jsonb)',
      [JSON.stringify(missingOwner)],
    );
  }
  // A real native owner move must not become absence or ready self.
  await f.admin.query("UPDATE core.partition SET write_state='moved', moved_to='other-node' WHERE partition_no=$1", [
    home(original),
  ]);
  try {
    expect(await store.readMapping(f.pool, original)).toEqual({ state: 'unavailable', reason: 'moved-owner' });
  } finally {
    await f.admin.query("UPDATE core.partition SET write_state='active', moved_to=NULL WHERE partition_no=$1", [
      home(original),
    ]);
  }
});
