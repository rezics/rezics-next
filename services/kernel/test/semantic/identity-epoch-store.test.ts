import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { writeSubject } from '../../src/semantic/subject.ts';
import type { IdentityIntent, IdentityJobRef, IdentityReceipt } from '../../src/semantic/identity-epoch-contract.ts';
import {
  stepIdentityEpochAdmission,
  cancelIdentityEpochAdmission,
  acquireIdentityEpochAdmissionHome,
} from '../../src/semantic/identity-epoch-admission.ts';
import acquireAdmission from '../../src/semantic/identity-epoch-admission-acquire.sql';
import { identityEpochStore as store } from '../../src/semantic/identity-epoch-store.ts';
import {
  readIdentityEpochCutover,
  stepIdentityEpochBootstrap,
  stepIdentityEpochBootstrapWork,
} from '../../src/semantic/identity-epoch-bootstrap.ts';
import { resolveSubject, readableSubjects } from '../../src/library/subject-anchor.ts';
import {
  digest,
  epochFixture,
  globalResource,
  home,
  release,
  seedLegacyGroup,
  seedLegacyRoot,
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
        partition: home(next.kind === 'merge' ? next.survivor : next.original),
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

async function requireCutover(_ids: string[]) {
  for (let step = 0; step < 100_000; step++) {
    const progress = await stepIdentityEpochBootstrapWork(f.pool);
    if (!progress) break;
    expect(progress.work.rows).toBeLessThanOrEqual(100);
    if (step === 99_999) throw new Error('Native bootstrap scheduler failed to settle finite topology');
  }
  expect((await readIdentityEpochCutover(f.pool)).state).toBe('ready');
}

async function storeSnapshot(ids: string[]) {
  return {
    legacy: await f.snapshot(ids),
    identity: await Promise.all(
      (
        await f.admin.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='semantic' AND left(tablename,15)='identity_epoch_' ORDER BY tablename",
        )
      ).rows.map(async ({ tablename }) => ({
        table: tablename,
        value: (
          await f.admin.query(
            `SELECT md5(coalesce(jsonb_agg(t ORDER BY to_jsonb(t)::text)::text,'null')) digest FROM semantic.${tablename} t`,
          )
        ).rows[0].digest,
      })),
    ),
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

test('stale home effect and fabricated step receipt cannot publish identity epoch', async () => {
  const original = (await f.create('Unhooked original', 0x6010)).subject.id;
  const destination = (await f.create('Wrong destination', 0x6020)).subject.id;
  const job: IdentityJobRef = { jobId: newId(routeOf(original)!), epoch: 1n };
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
    runCommand(f.pool, { partition: home(job.jobId) }, (tx) => store.publish(tx, job)),
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

test('bounded bootstrap never infers self or readiness from absent mapping', async () => {
  const original = await seedLegacyRoot(f, 0x5e10);
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
  expect(await readIdentityEpochCutover(f.pool)).toEqual({ state: 'blocked' });
  const outside = (await f.admin.query('SELECT 1 FROM semantic.identity_epoch_bootstrap_home WHERE partition_no=4094'))
    .rowCount;
  expect(outside).toBe(0);
  // A create after the scan, and a redirect at an already visited key, must enter maintained dirty work.
  const concurrent = (await f.create('Concurrent legacy create', 0x5e10)).subject.id;
  const survivor = (await f.create('Concurrent destination', 0x5e10)).subject.id;
  await f.merge(concurrent, survivor);
  await bootstrapHome(home(original));
  expect(
    (await f.admin.query('SELECT terminal FROM semantic.identity_epoch_original WHERE original=$1', [concurrent]))
      .rows[0].terminal,
  ).toBe(survivor);
  expect(await store.readMapping(f.pool, members[0]!)).toMatchObject({ state: 'mapped', terminal: original });
  const before = await storeSnapshot([original]);
  await expect(
    (await admission({ kind: 'merge', survivor: original, redirected: concurrent, release: release.digest })).execute(),
  ).rejects.toMatchObject({ code: 'identity_epoch_unavailable' });
  expect(await storeSnapshot([original])).toEqual(before);
  await requireCutover([original]);
  expect(await store.readMapping(f.pool, members[0]!)).toMatchObject({ state: 'mapped', terminal: original });
}, 600_000);

test('native cross-home redirect withdraws its old group before the Library current route is disclosed', async () => {
  const original = (await f.create('Cross-home native source', 0x6210)).subject.id;
  const terminal = (await f.create('Cross-home native terminal', 0x6220)).subject.id;
  await f.merge(original, terminal);
  expect(await store.readMapping(f.pool, original)).toEqual({ state: 'unavailable', reason: 'bootstrap' });
  await bootstrapHome(home(original));
  expect(await store.readMapping(f.pool, original)).toMatchObject({ state: 'mapped', original, terminal });
  expect(await resolveSubject({ pool: f.pool, access: f.access }, await f.actor(), original)).toEqual({
    subjectId: terminal,
    requestedSubjectId: original,
  });
  const copies = (
    await f.admin.query('SELECT terminal,partition_no FROM semantic.identity_epoch_original WHERE original=$1', [
      original,
    ])
  ).rows;
  expect(copies).toEqual([{ terminal, partition_no: home(terminal) }]);
  const mapping = await store.readMapping(f.pool, original);
  if (mapping.state !== 'mapped') throw new Error('Expected the actual current bootstrap mapping');
  await runCommand(f.pool, { partition: home(terminal) }, async (tx) => {
    await store.admitHomeEffect(tx, { kind: 'follow-count', original, terminal, epoch: mapping.epoch });
    return noEffect(null);
  });
  await expect(
    runCommand(f.pool, { partition: home(original) }, async (tx) => {
      await store.admitHomeEffect(tx, { kind: 'follow-count', original, terminal: original, epoch: mapping.epoch });
      return noEffect(null);
    }),
  ).rejects.toMatchObject({ code: 'identity_effect_stale' });
  const counts = (
    await f.admin.query(
      'SELECT terminal,observed_count::text FROM semantic.identity_epoch_group WHERE terminal=ANY($1::uuid[]) ORDER BY terminal',
      [[original, terminal]],
    )
  ).rows;
  expect(counts.find((g) => g.terminal === original)?.observed_count).toBe('0');
  expect(counts.find((g) => g.terminal === terminal)?.observed_count).toBe('2');
});

test('native identity store admits one capped durable job with no early publication and idempotent authorized receipt', async () => {
  const survivor = (await f.create()).subject.id;
  const redirected = (await f.create()).subject.id;
  const inherited = await seedLegacyGroup(f, redirected, 200);
  await requireCutover([survivor, redirected]);
  const intent = { kind: 'merge' as const, survivor, redirected, release: release.digest };
  const { execute, receipt } = await admission(intent);
  const before = await store.readEpoch(f.pool, home(survivor));
  const admitted = await execute();
  const job = admitted.value;
  expect(await store.readEpoch(f.pool, home(survivor))).toEqual({
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
    runCommand(f.pool, { partition: home(job.jobId) }, (tx) => store.publish(tx, job)),
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

test('native current mapping resolves a created original through the real Library subject reader', async () => {
  const created = await f.create('Library identity mapping consumer');
  const mapping = await store.readMapping(f.pool, created.subject.id);
  expect(mapping).toMatchObject({
    state: 'mapped',
    original: created.subject.id,
    terminal: created.subject.id,
    epoch: 1n,
  });
  expect(await resolveSubject({ pool: f.pool, access: f.access }, await f.actor(), created.subject.id)).toEqual({
    subjectId: created.subject.id,
    requestedSubjectId: null,
  });
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

test('partition P=1 refuses a second local reservation without effects while disjoint Library members progress', async () => {
  const left = (await f.create('First native reservation', 0x6110)).subject.id;
  const right = (await f.create('First native input', 0x6110)).subject.id;
  const job = (
    await (await admission({ kind: 'merge', survivor: left, redirected: right, release: release.digest })).execute()
  ).value;
  expect(await store.readMapping(f.pool, left)).toEqual({ state: 'pending', original: left, job });
  expect(await resolveSubject({ pool: f.pool, access: f.access }, await f.actor(), left)).toBeNull();
  const localA = (await f.create('Independent same-home group', 0x6110)).subject.id;
  const localB = (await f.create('Independent same-home input', 0x6110)).subject.id;
  const before = await storeSnapshot([localA, localB]);
  await expect(
    (await admission({ kind: 'merge', survivor: localA, redirected: localB, release: release.digest })).execute(),
  ).rejects.toMatchObject({ code: 'identity_epoch_unavailable' });
  expect(await storeSnapshot([localA, localB])).toEqual(before);
  const disjoint = (await f.create('Disjoint shelf source', 0x6120)).subject.id;
  expect(await readableSubjects({ pool: f.pool, access: f.access }, await f.actor(), [left, disjoint])).toEqual([
    disjoint,
  ]);
  const other = (await f.create('Disjoint merge input', 0x6120)).subject.id;
  const second = (
    await (await admission({ kind: 'merge', survivor: disjoint, redirected: other, release: release.digest })).execute()
  ).value;
  expect(second.jobId).not.toBe(job.jobId);
  expect(await store.readMapping(f.pool, disjoint)).toEqual({ state: 'pending', original: disjoint, job: second });
  expect((await store.readJob(f.pool, job))?.state).toBe('pending');
  for (const pending of [job, second])
    await expect(
      runCommand(f.pool, { partition: home(pending.jobId) }, (tx) => store.publish(tx, pending)),
    ).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
});

test('complete resulting group of exactly 4096 originals is admitted and remains pending without participant custody', async () => {
  const survivor = (await f.create('4096 terminal', 0x6130)).subject.id;
  const redirected = (await f.create('4096 merged root', 0x6130)).subject.id;
  await seedLegacyGroup(f, redirected, 4094);
  await requireCutover([survivor, redirected]);
  const job = (await (await admission({ kind: 'merge', survivor, redirected, release: release.digest })).execute())
    .value;
  let after: string | null = null;
  let total = 0;
  do {
    const page = await store.pageChanges(f.pool, job, after);
    expect(page.changes.length).toBeLessThanOrEqual(100);
    total += page.changes.length;
    after = page.next;
  } while (after !== null);
  expect(total).toBe(4096);
  expect(await store.readMapping(f.pool, redirected)).toEqual({ state: 'pending', original: redirected, job });
  await expect(
    runCommand(f.pool, { partition: home(job.jobId) }, (tx) => store.publish(tx, job)),
  ).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
}, 600_000);

test('one native RR cut stays coherent when admission commits between source and control reads', async () => {
  const survivor = (await f.create('RR survivor', 0x6140)).subject.id;
  const redirected = (await f.create('RR input', 0x6140)).subject.id;
  let captured!: () => void;
  let releaseSnapshot!: () => void;
  const sourceRead = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  let restore: (() => void) | undefined;
  f.pool.once('acquire', (client: PoolClient) => {
    const query = client.query;
    restore = () => {
      client.query = query;
    };
    client.query = async function (...args: unknown[]) {
      const result = await Reflect.apply(query, client, args);
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text;
      if (text?.includes('identity_epoch_mapping')) {
        restore!();
        captured();
        await proceed;
      }
      return result;
    } as PoolClient['query'];
  });
  const observation = store.readMapping(f.pool, survivor);
  let job: IdentityJobRef;
  try {
    await sourceRead;
    job = (await (await admission({ kind: 'merge', survivor, redirected, release: release.digest })).execute()).value;
  } finally {
    restore?.();
    releaseSnapshot();
  }
  // The snapshot predates the admission; neither a later control cut nor an extra source snapshot is mixed in.
  expect(await observation).toMatchObject({ state: 'mapped', terminal: survivor });
  expect(await store.readMapping(f.pool, survivor)).toEqual({ state: 'pending', original: survivor, job });
});

test('ordered PREPARING recovery and cancellation keep P=1 local, including uncertain and delayed acquisition', async () => {
  const create = async (label: string, route: number) => (await f.create(label, route)).subject.id;
  const actor = await f.actor();
  const authority = {
    basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
    authorization: await f.authorization('subject:merge'),
  };
  const prepare = async (survivor: string, redirected: string) => {
    const key = randomUUID();
    const input = {
      intent: { kind: 'merge', survivor, redirected, release: release.digest } as const,
      receipt: {
        kind: 'subject.merge',
        command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: digest(key) },
      } as const,
    };
    return { input, job: await store.prepareAdmission(f.pool, authority, input) };
  };
  // A terminal admitted job at the highest resource waits for real participants, never a lease.
  const occupiedA = await create('Highest occupied A', 0x6330);
  const occupiedB = await create('Highest occupied B', 0x6330);
  const occupied = (
    await (
      await admission({ kind: 'merge', survivor: occupiedA, redirected: occupiedB, release: release.digest })
    ).execute()
  ).value;
  const highA = await create('High lower group', 0x6320);
  const highB = await create('High upper group', 0x6330);
  const high = await prepare(highB, highA);
  expect(home(high.job.jobId)).toBe(home(highA));
  expect(await store.prepareAdmission(f.pool, authority, high.input)).toEqual(high.job);
  expect(await store.readMapping(f.pool, highA)).toEqual({ state: 'pending', original: highA, job: high.job });
  await stepIdentityEpochAdmission(f.pool, high.job); // Real first-home receipt moves into job custody.
  await expect(stepIdentityEpochAdmission(f.pool, high.job)).rejects.toMatchObject({
    code: 'identity_epoch_unavailable',
  });
  const lowA = await create('Low first group', 0x6310);
  const lowB = await create('Low next group', 0x6320);
  const low = await prepare(lowB, lowA);
  await stepIdentityEpochAdmission(f.pool, low.job);
  await expect(stepIdentityEpochAdmission(f.pool, low.job)).rejects.toMatchObject({
    code: 'identity_epoch_unavailable',
  });
  const plans = (
    await f.admin.query(
      'SELECT job_id,resource_home FROM semantic.identity_epoch_admission_plan WHERE job_id=ANY($1::uuid[]) ORDER BY job_id,resource_home',
      [[high.job.jobId, low.job.jobId]],
    )
  ).rows;
  for (const job of [high.job, low.job])
    expect(plans.filter((p) => p.job_id === job.jobId).map((p) => p.resource_home)).toEqual(
      job === high.job ? [home(highA), home(highB)] : [home(lowA), home(lowB)],
    );
  const unrelated = await create('Unrelated fresh shelf', 0x6340);
  expect(await readableSubjects({ pool: f.pool, access: f.access }, actor, [lowA, highA, unrelated])).toEqual([
    unrelated,
  ]);
  // Cancellation closes acquired AND never-acquired homes without taking another slot.
  const closingPeer = await create('Closing home new group', 0x6320);
  await cancelIdentityEpochAdmission(f.pool, high.job);
  await stepIdentityEpochAdmission(f.pool, high.job);
  // Job-home history remains CANCELLING until every uncertain home has real close custody.
  // Its unique physical reservation refuses a new local job through the public error contract.
  const closingSnapshot = await storeSnapshot([highA, closingPeer]);
  await expect(prepare(closingPeer, highA)).rejects.toMatchObject({ code: 'identity_epoch_unavailable' });
  expect(await storeSnapshot([highA, closingPeer])).toEqual(closingSnapshot);
  for (let i = 0; i < 2; i++) await stepIdentityEpochAdmission(f.pool, high.job);
  expect((await store.readJob(f.pool, high.job))?.state).toBe('cancelled');
  expect((await store.readJob(f.pool, occupied))?.state).toBe('pending');
  expect(await store.readMapping(f.pool, highA)).toMatchObject({ state: 'mapped', terminal: highA });
  const scope = (
    await f.admin.query('SELECT scope_digest FROM semantic.identity_epoch_job WHERE job_id=$1', [high.job.jobId])
  ).rows[0].scope_digest;
  // This is the actual native receiving operation a delivery already in flight would execute.
  for (const resource of [home(highA), home(highB)])
    await expect(
      runCommand(f.pool, { partition: resource }, async (tx) => {
        await tx.query(acquireAdmission.sql, [resource, high.job.jobId, high.job.epoch.toString(), scope]);
        return noEffect(null);
      }),
    ).rejects.toMatchObject({ message: 'identity_effect_stale' });
  const closed = (
    await f.admin.query(
      "SELECT r.partition_no FROM semantic.identity_epoch_admission_receipt r JOIN semantic.identity_epoch_native_commit c USING(partition_no,transaction_id) WHERE r.job_id=$1 AND r.stage='closed' AND r.xmin=c.xmin",
      [high.job.jobId],
    )
  ).rows;
  expect(closed).toHaveLength(2);
  expect(
    (
      await f.admin.query('SELECT count(*)::text n FROM semantic.identity_epoch_input WHERE job_id=$1', [
        high.job.jobId,
      ])
    ).rows[0].n,
  ).toBe('0');
  // Lose the response after the real receiving commit, then retry it and reconcile its native receipt.
  await acquireIdentityEpochAdmissionHome(f.pool, low.job, home(lowB));
  await acquireIdentityEpochAdmissionHome(f.pool, low.job, home(lowB));
  await stepIdentityEpochAdmission(f.pool, low.job);
  expect((await stepIdentityEpochAdmission(f.pool, low.job)).state).toBe('pending');
  await expect(cancelIdentityEpochAdmission(f.pool, low.job)).rejects.toMatchObject({ code: 'identity_effect_stale' });
  expect(
    (
      await f.admin.query(
        "SELECT count(*)::text n FROM semantic.identity_epoch_admission_attempt WHERE partition_no=$1 AND state='acquired'",
        [home(lowB)],
      )
    ).rows[0].n,
  ).toBe('1');
  await expect(
    runCommand(f.pool, { partition: home(low.job.jobId) }, (tx) => store.publish(tx, low.job)),
  ).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
});

test('same-transaction native births retain independent immutable group generations', async () => {
  const originals = [newId(0x6360), newId(0x6360), newId(0x6360)];
  const actor = await f.actor();
  await runCommand(
    f.pool,
    {
      partition: home(originals[0]!),
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      authorization: await f.authorization('subject:create'),
    },
    async (tx, { transactionId }) => {
      const results = [];
      for (const id of originals)
        results.push(
          await writeSubject(tx, transactionId, {
            target: { route: routeOf(id)!, id },
            item: { type: 'schema:Person', labels: { en: 'Native batch birth' } },
            release,
          }),
        );
      return { value: null, events: results.flatMap((result) => result.events) };
    },
  );
  const headers = (
    await f.admin.query('SELECT generation FROM semantic.identity_epoch_group WHERE terminal=ANY($1::uuid[])', [
      originals,
    ])
  ).rows;
  expect(new Set(headers.map((h) => h.generation)).size).toBe(3);
  const job = (
    await (
      await admission({ kind: 'merge', survivor: originals[0]!, redirected: originals[1]!, release: release.digest })
    ).execute()
  ).value;
  expect((await store.pageChanges(f.pool, job, null)).changes.map((c) => c.original).sort()).toEqual(
    originals.slice(0, 2).sort(),
  );
  expect(await store.readMapping(f.pool, originals[2]!)).toMatchObject({ state: 'mapped', terminal: originals[2] });
});
