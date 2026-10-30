import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { moderateSubject } from '../../src/semantic/moderation.ts';
import { resolveSubject } from '../../src/library/subject-anchor.ts';
import { identityEpochStore as store, identityJobPartition } from '../../src/semantic/identity-epoch-store.ts';
import { stepIdentityEpochMapping } from '../../src/semantic/identity-epoch-mapping.ts';
import {
  cancelIdentityEpochAdmission,
  stepIdentityEpochAdmission,
} from '../../src/semantic/identity-epoch-admission.ts';
import { installIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap-install.ts';
import {
  readIdentityEpochCutover,
  runIdentityEpochBootstrapBatch,
} from '../../src/semantic/identity-epoch-bootstrap.ts';
import type {
  IdentityIntent,
  IdentityJobRef,
  IdentityStepProgress,
} from '../../src/semantic/identity-epoch-contract.ts';
import { digest, globalResource, home, release, seedLegacyGroup, type EpochFixture } from './support/identity-epoch.ts';
import {
  allChanges,
  cutoverFixture,
  interruptNativeStatement,
  withoutOwner,
} from './support/identity-epoch-cutover.ts';
import { admittedReceivingJob, completeReceivingParticipant } from './support/identity-receiving-effects.ts';
import { createRealAccess } from './real-access.ts';

// These are native calls on the established fixture, not a substitute mapping/receipt producer.
async function admit(f: EpochFixture, intent: IdentityIntent) {
  const actor = await f.actor();
  const key = randomUUID();
  const input = {
    intent,
    receipt: {
      kind: 'subject.merge' as const,
      command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: digest(key) },
    },
  };
  const authority = {
    basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
    authorization: await f.authorization('subject:merge'),
  };
  const job = await store.prepareAdmission(f.pool, authority, input);
  for (let page = 0; page < 512; page++) {
    const progress = await stepIdentityEpochAdmission(f.pool, job);
    expect(progress.work.rows).toBeLessThanOrEqual(100);
    if (progress.state === 'pending') {
      expect(await store.prepareAdmission(f.pool, authority, input)).toEqual(job);
      return job;
    }
    expect(progress.state).toBe('preparing');
  }
  throw new Error('Native admission did not finish finite immutable inputs');
}

async function bootstrap(f: EpochFixture) {
  await installIdentityEpochBootstrap(f.pool);
  for (let batch = 0; batch < 512; batch++) {
    if ((await readIdentityEpochCutover(f.pool)).state === 'ready') return;
    await runIdentityEpochBootstrapBatch(f.pool);
  }
  throw new Error('Native bootstrap did not close its finite topology');
}

async function drain(f: EpochFixture, job: IdentityJobRef) {
  const progress: IdentityStepProgress[] = [];
  for (let page = 0; page < 512; page++) {
    const next = await stepIdentityEpochMapping(f.pool, job);
    expect(next.job).toEqual(job);
    expect(next.receipt).toMatchObject({ job, step: 'mapping', version: 1 });
    expect(next.work.rows).toBeLessThanOrEqual(100);
    expect(next.frontier.after.length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(JSON.stringify(next.frontier))).toBeLessThanOrEqual(2048);
    // Read the actual same-transaction frontier/native receipt, rather than trusting the return value.
    const native = await f.admin.query(
      `SELECT s.frontier,s.state,s.work FROM semantic.identity_epoch_step s
       JOIN semantic.identity_epoch_native_commit c
         ON (c.partition_no,c.transaction_id,c.epoch,c.position)=
            (s.partition_no,s.transaction_id,s.native_epoch,s.native_position) AND c.xmin=s.xmin
       JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch
       WHERE s.partition_no=$1 AND s.transaction_id=$2 AND s.native_epoch=$3 AND s.native_position=$4
         AND s.job_id=$5 AND s.job_epoch=$6 AND s.step='mapping' AND s.version=1
         AND c.purpose='mapping' AND p.write_state='active' AND p.position>=c.position`,
      [
        next.receipt.native.partition,
        next.receipt.native.transactionId,
        next.receipt.native.epoch,
        next.receipt.native.position.toString(),
        job.jobId,
        job.epoch.toString(),
      ],
    );
    expect(native.rows).toEqual([{ frontier: next.frontier, state: next.state, work: next.work }]);
    expect(next.receipt.native.position).toBeGreaterThan(0n);
    if (progress.length) expect(next.receipt).not.toEqual(progress.at(-1)!.receipt);
    progress.push(next);
    if (next.state === 'complete') return progress;
  }
  throw new Error('Native mapping failed to finish within 512 bounded steps');
}

async function directRedirect(f: EpochFixture, original: string) {
  const rows = await f.admin.query(
    'SELECT target FROM semantic.redirect WHERE route=$1 AND subject_id=$2 ORDER BY sequence DESC LIMIT 1',
    [routeOf(original), original],
  );
  return rows.rows[0]?.target ?? original;
}

test('native mapping drains admitted effects with real receipt custody but cannot publish missing fixed participants', async () => {
  const f = await cutoverFixture();
  f.pool.options.max = 1;
  try {
    await bootstrap(f);
    const original = (await f.create('Mapping original', 0x5f10)).id;
    const terminal = (await f.create('Requested survivor', 0x5f20)).id;
    const job = await admit(f, { kind: 'merge', redirected: original, survivor: terminal, release: release.digest });
    const changes = await allChanges(f, store, job);
    expect(changes).toContainEqual({ original, previousTerminal: original, terminal });
    expect(changes).toContainEqual({ original: terminal, previousTerminal: terminal, terminal });
    expect(await store.readMapping(f.pool, original)).toEqual({ state: 'pending', original, job });
    const final = (await drain(f, job)).at(-1)!;
    expect(final.state).toBe('complete');
    expect(await directRedirect(f, original)).toBe(terminal);
    expect(await store.reconcileStepReceipt(f.pool, final.receipt)).toEqual(final);
    expect(await store.reconcileStepReceipt(f.pool, final.receipt)).toEqual(final);
    const saved = await store.readJob(f.pool, job);
    expect(saved?.mapping).toEqual(final);
    expect(saved?.participants).toEqual({ 'search-canonical-index': null, 'library-private-follow-counts': null });
    const before = await f.snapshot([original, terminal]);
    const replay = await stepIdentityEpochMapping(f.pool, job);
    expect(replay).toEqual(final);
    expect(await f.snapshot([original, terminal])).toEqual(before);
    expect(await allChanges(f, store, job)).toEqual(changes);
    await expect(
      runCommand(f.pool, { partition: identityJobPartition(job) }, (tx) => store.publish(tx, job)),
    ).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
    expect((await store.readJob(f.pool, job))?.state).toBe('pending');
    expect(f.pool.totalCount).toBeLessThanOrEqual(1);
  } finally {
    await f.close();
  }
}, 180_000);

test('a current hidden original stays concealed while its native mapping and public terminal remain intact', async () => {
  const f = await cutoverFixture();
  try {
    const terminal = (await f.create('Visible native terminal', 0x6610)).id;
    const [original] = await seedLegacyGroup(f, terminal, 1);
    if (!original) throw new Error('Native legacy original was not created');
    await bootstrap(f);
    expect(await store.readMapping(f.pool, original)).toMatchObject({ state: 'mapped', original, terminal });
    expect(await resolveSubject({ pool: f.pool, access: f.access }, await f.actor(), original)).toEqual({
      subjectId: terminal,
      requestedSubjectId: original,
    });
    const real = await createRealAccess(f.admin, { moderator: newId(0x6630) }, ['moderation:hide']);
    const access = real.access({ actions: new Map([['moderation:hide', { anonymous: false }]]) });
    await real.grant(globalResource, 'moderator', 'moderation:hide');
    const context = { pool: f.pool, deadline: Date.now() + 5000 };
    const actor = await access.authenticate(real.bearer('moderator'), context);
    const key = randomUUID();
    await moderateSubject(f.pool, {
      actor,
      subject: original,
      action: 'hide',
      body: { reason: 'Conceal the original independently' },
      idempotencyKey: key,
      digest: digest(key),
      deadline: context.deadline,
      authorization: await accessCommandAuthorization(
        access,
        actor,
        'moderation:hide',
        globalResource,
        context,
        () => new Error('Native moderation denied'),
      ),
    });
    expect(await store.readMapping(f.pool, original)).toMatchObject({ state: 'mapped', original, terminal });
    expect(await directRedirect(f, original)).toBe(terminal);
    expect(await resolveSubject({ pool: f.pool, access: f.access }, await f.actor(), terminal)).toEqual({
      subjectId: terminal,
      requestedSubjectId: null,
    });
    expect(await resolveSubject({ pool: f.pool, access: f.access }, await f.actor(), original)).toBeNull();
  } finally {
    await f.close();
  }
}, 180_000);

for (const kind of ['merge', 'repoint'] as const) {
  test(`native ${kind} retains immutable generation inputs and pages a terminal detachment past raw 100`, async () => {
    const f = await cutoverFixture();
    f.pool.options.max = 1;
    try {
      const original = (await f.create('Captured group root', 0x6210)).id;
      const members = await seedLegacyGroup(f, original, 101);
      const terminal = (await f.create('Actual target', 0x6220)).id;
      await bootstrap(f);
      const intent: IdentityIntent =
        kind === 'merge'
          ? { kind, redirected: original, survivor: terminal, release: release.digest }
          : { kind, original, terminal, release: release.digest };
      const job = await admit(f, intent);
      const inputs = await f.admin.query(
        'SELECT * FROM semantic.identity_epoch_input WHERE partition_no=$1 AND job_id=$2 ORDER BY terminal LIMIT 2',
        [identityJobPartition(job), job.jobId],
      );
      expect(inputs.rows).toHaveLength(2);
      for (const input of inputs.rows) {
        expect(input.generation).toBeString();
        expect(BigInt(input.original_count)).toBeGreaterThan(0n);
      }
      const first = await store.pageChanges(f.pool, job, null);
      expect(first.changes.length).toBeGreaterThan(0);
      expect(first.changes.length).toBeLessThanOrEqual(100);
      expect(first.next).not.toBeNull();
      const changes = await allChanges(f, store, job);
      expect(new Set(changes.map((change) => change.original)).size).toBe(changes.length);
      const remainder = members[0]!; // seedLegacyGroup returns native originals in structural key order.
      for (const member of members)
        expect(changes).toContainEqual({
          original: member,
          previousTerminal: original,
          terminal: kind === 'merge' ? terminal : remainder,
        });
      expect(changes).toContainEqual({ original, previousTerminal: original, terminal });
      const final = (await drain(f, job)).at(-1)!;
      await store.reconcileStepReceipt(f.pool, final.receipt);
      for (const change of changes) expect(await directRedirect(f, change.original)).toBe(change.terminal);
      expect(await store.pageChanges(f.pool, job, null)).toEqual(first);
      expect(
        (
          await f.admin.query(
            'SELECT * FROM semantic.identity_epoch_input WHERE partition_no=$1 AND job_id=$2 ORDER BY terminal LIMIT 2',
            [identityJobPartition(job), job.jobId],
          )
        ).rows,
      ).toEqual(inputs.rows);
      expect((await store.readJob(f.pool, job))?.intent).toEqual(intent);
    } finally {
      await f.close();
    }
  }, 180_000);
}

for (const size of [64, 512, 4096]) {
  test(`native mapping preserves every original in a ${size}-original admitted group with bounded member maintenance`, async () => {
    const f = await cutoverFixture();
    f.pool.options.max = 1;
    try {
      const original = (await f.create('Many-original source', 0x6810)).id;
      const members = await seedLegacyGroup(f, original, size - 2);
      const terminal = (await f.create('Many-original survivor', 0x6820)).id;
      await bootstrap(f);
      const job = await admit(f, { kind: 'merge', redirected: original, survivor: terminal, release: release.digest });
      const changes = await allChanges(f, store, job);
      expect(changes).toHaveLength(size);
      expect(new Set(changes.map((change) => change.original))).toEqual(new Set([original, ...members, terminal]));
      const final = (await drain(f, job)).at(-1)!;
      await store.reconcileStepReceipt(f.pool, final.receipt);
      for (const id of [original, ...members]) expect(await directRedirect(f, id)).toBe(terminal);
      expect(await allChanges(f, store, job)).toEqual(changes);
      expect(await stepIdentityEpochMapping(f.pool, job)).toEqual(final);
      expect(f.pool.totalCount).toBeLessThanOrEqual(1);
    } finally {
      await f.close();
    }
  }, 180_000);
}

test('native same-home admission rolls back with its effect and rejects a foreign home and stale epoch', async () => {
  const f = await cutoverFixture();
  f.pool.options.max = 1;
  try {
    await bootstrap(f);
    const original = (await f.create('Effect original', 0x6310)).id;
    const terminal = (await f.create('Effect terminal', 0x6320)).id;
    const job = await admit(f, { kind: 'merge', redirected: original, survivor: terminal, release: release.digest });
    const effect = { kind: 'structural' as const, job, original };
    const before = await f.snapshot([original, terminal]);
    const rollback = new Error('Roll back native home admission');
    await expect(
      runCommand(f.pool, { partition: home(original) }, async (tx) => {
        await store.admitHomeEffect(tx, effect);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await f.snapshot([original, terminal])).toEqual(before);
    for (const [partition, changed] of [
      [home(terminal), effect],
      [home(original), { ...effect, job: { ...job, epoch: job.epoch + 1n } }],
    ] as const)
      await expect(
        runCommand(f.pool, { partition }, async (tx) => {
          await store.admitHomeEffect(tx, changed);
          return noEffect(null);
        }),
      ).rejects.toThrow();
    expect(await f.snapshot([original, terminal])).toEqual(before);
    await drain(f, job);
  } finally {
    await f.close();
  }
}, 180_000);

test('a lost native mapping transaction and control ACK retry preserve exact receipt identity', async () => {
  const f = await cutoverFixture();
  f.pool.options.max = 1;
  try {
    await bootstrap(f);
    const original = (await f.create('Interrupted mapping', 0x6410)).id;
    const terminal = (await f.create('Interrupted target', 0x6420)).id;
    const job = await admit(f, { kind: 'merge', redirected: original, survivor: terminal, release: release.digest });
    await interruptNativeStatement(f, /INSERT INTO semantic\.identity_epoch_step\b/i, () =>
      stepIdentityEpochMapping(f.pool, job),
    );
    const final = (await drain(f, job)).at(-1)!;
    const before = await f.snapshot([original, terminal]);
    await interruptNativeStatement(f, /INSERT INTO semantic\.identity_epoch_ack\b/i, () =>
      store.reconcileStepReceipt(f.pool, final.receipt),
    );
    expect((await store.readJob(f.pool, job))?.mapping).toBeNull();
    expect(await stepIdentityEpochMapping(f.pool, job)).toEqual(final);
    expect(await store.reconcileStepReceipt(f.pool, final.receipt)).toEqual(final);
    expect(await directRedirect(f, original)).toBe(terminal);
    expect((await f.snapshot([original, terminal])).revisions).toEqual(before.revisions);
    for (const native of [
      { ...final.receipt.native, transactionId: randomUUID() },
      { ...final.receipt.native, epoch: final.receipt.native.epoch + 1 },
      {
        ...final.receipt.native,
        partition: home(original) === final.receipt.native.partition ? home(terminal) : home(original),
      },
    ])
      await expect(store.reconcileStepReceipt(f.pool, { ...final.receipt, native })).rejects.toMatchObject({
        code: 'identity_step_receipt_invalid',
      });
    await withoutOwner(f, final.receipt.native.partition, async () => {
      await expect(store.reconcileStepReceipt(f.pool, final.receipt)).rejects.toThrow();
    });
    expect(await store.reconcileStepReceipt(f.pool, final.receipt)).toEqual(final);
  } finally {
    await f.close();
  }
}, 180_000);

test('cancelled native preparation cannot be resurrected by delayed mapping delivery', async () => {
  const f = await cutoverFixture();
  try {
    await bootstrap(f);
    const original = (await f.create('Cancelled original', 0x6510)).id;
    const terminal = (await f.create('Cancelled target', 0x6520)).id;
    const actor = await f.actor();
    const key = randomUUID();
    const job = await store.prepareAdmission(
      f.pool,
      {
        basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
        authorization: await f.authorization('subject:merge'),
      },
      {
        intent: { kind: 'merge', redirected: original, survivor: terminal, release: release.digest },
        receipt: {
          kind: 'subject.merge',
          command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: digest(key) },
        },
      },
    );
    await cancelIdentityEpochAdmission(f.pool, job);
    for (let page = 0; page < 32; page++) {
      if ((await stepIdentityEpochAdmission(f.pool, job)).state === 'cancelled') break;
    }
    expect((await store.readJob(f.pool, job))?.state).toBe('cancelled');
    const before = await f.snapshot([original, terminal]);
    await expect(stepIdentityEpochMapping(f.pool, job)).rejects.toThrow();
    expect(await f.snapshot([original, terminal])).toEqual(before);
    expect(await directRedirect(f, original)).toBe(original);
  } finally {
    await f.close();
  }
}, 180_000);

test('real Library receiving effects retain exact job original OLD NEW and first-apply custody without rewriting occurrences', async () => {
  const f = await cutoverFixture();
  f.pool.options.max = 1;
  try {
    await bootstrap(f);
    const input = await admittedReceivingJob(f);
    const before = await input.members();
    const mapping = (await drain(f, input.job)).at(-1)!;
    await store.reconcileStepReceipt(f.pool, mapping.receipt);
    const progress = await completeReceivingParticipant(f, input.job);
    await store.reconcileStepReceipt(f.pool, progress.receipt);
    const effects = (
      await f.admin.query(
        `SELECT r.original,r.binding,r.plan,e.frontier,c.transaction_id
       FROM semantic.identity_epoch_receiving_record r
       JOIN semantic.identity_epoch_receiving_effect e
         ON (e.partition_no,e.job_id,e.effect_key)=(r.partition_no,r.job_id,r.effect_key)
       JOIN semantic.identity_epoch_native_commit c
         ON (c.partition_no,c.transaction_id)=(e.partition_no,e.transaction_id) AND c.xmin=e.xmin
       WHERE r.partition_no=$1 AND r.job_id=$2 AND r.job_epoch=$3 ORDER BY r.effect_key`,
        [home(input.library.collection.id), input.job.jobId, input.job.epoch.toString()],
      )
    ).rows;
    expect(effects.length).toBeGreaterThan(0);
    for (const disposition of ['OLD', 'NEW', 'first-apply'])
      expect(
        effects.some((effect) => effect.binding.source.disposition === disposition),
        disposition,
      ).toBe(true);
    for (const effect of effects) {
      expect(effect.binding.job).toEqual({ jobId: input.job.jobId, epoch: input.job.epoch.toString() });
      expect(effect.binding.original).toBe(effect.original);
      expect([input.original, input.terminal]).toContain(effect.original);
      expect(effect.binding.step).toBe('library-private-follow-counts');
      expect(effect.binding.version).toBe(1);
      expect(effect.transaction_id).toBeString();
      expect(effect.frontier.after.length).toBeLessThanOrEqual(8);
    }
    expect(await input.members()).toEqual(before);
    // Even a real Library receipt is insufficient while the fixed Search participant is absent.
    await expect(
      runCommand(f.pool, { partition: identityJobPartition(input.job) }, (tx) => store.publish(tx, input.job)),
    ).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
    expect(await resolveSubject({ pool: f.pool, access: f.access }, await f.actor(), input.original)).toBeNull();
  } finally {
    await f.close();
  }
}, 180_000);
