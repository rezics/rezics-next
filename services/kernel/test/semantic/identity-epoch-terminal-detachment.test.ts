import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { withConnection } from '../../src/database/pool.ts';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { identityEpochStore, identityJobPartition } from '../../src/semantic/identity-epoch-store.ts';
import { stepIdentityEpochMapping } from '../../src/semantic/identity-epoch-mapping.ts';
import { moveMergePage } from '../../src/semantic/merge-moves.ts';
import { moderateSubject } from '../../src/semantic/moderation.ts';
import { createRealAccess } from './real-access.ts';
import { createIdentityMappingFixture } from './support/identity-epoch-mapping.ts';
import { digest, globalResource, release } from './support/identity-epoch.ts';

for (const terminalLast of [false, true]) {
  test(`terminal repoint retains a flat immutable remainder with terminal ${terminalLast ? 'after' : 'before'} its members`, async () => {
    const f = await createIdentityMappingFixture({ poolMax: 1 });
    const sourceRoute = terminalLast ? 0xb140 : 0xb100;
    try {
      const originals: string[] = [];
      for (let n = 0; n < 3; n++)
        originals.push((await f.create('Native terminal detachment original', sourceRoute)).subject.id);
      originals.sort();
      const original = terminalLast ? originals.at(-1)! : originals[0]!;
      const remaining = originals.filter((id) => id !== original);
      const remainder = remaining[0]!;
      for (const member of remaining) {
        await f.merge(member, original);
        let finished = false;
        for (let n = 0; n < 8; n++) {
          if (!(await moveMergePage(f.pool, member, original))) {
            finished = true;
            break;
          }
        }
        expect(finished).toBe(true);
      }
      if (!terminalLast) {
        const real = await createRealAccess(f.admin, { moderator: newId(sourceRoute) }, ['moderation:hide']);
        await real.grant(globalResource, 'moderator', 'moderation:hide');
        const access = real.access({ actions: new Map([['moderation:hide', { anonymous: false }]]) });
        const context = { pool: f.pool, deadline: Date.now() + 5000 };
        const actor = await access.authenticate(real.bearer('moderator'), context);
        const key = randomUUID();
        await moderateSubject(f.pool, {
          actor,
          subject: remainder,
          action: 'hide',
          body: { reason: 'Remainder selection uses structural membership' },
          idempotencyKey: key,
          digest: digest(key),
          authorization: await accessCommandAuthorization(
            access,
            actor,
            'moderation:hide',
            globalResource,
            context,
            () => new Error('Denied moderation'),
          ),
          deadline: context.deadline,
        });
      }
      await f.bootstrapHomes(originals);
      // Put the target's control home first, independently of the source's native UUID ordering.
      const terminal = (await f.create('Separate repoint destination', sourceRoute - 16)).subject.id;
      const intent = { kind: 'repoint' as const, original, terminal, release: release.digest };
      const job = await f.admit(intent);
      const home = identityJobPartition(job);
      const saved = (
        await f.admin.query(
          'SELECT intent,remainder_terminal FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2',
          [home, job.jobId],
        )
      ).rows[0]!;
      expect(saved.intent).toEqual(intent);
      expect(saved.remainder_terminal).toBe(remainder);
      const page = await withConnection(f.pool, (tx) => identityEpochStore().pageChanges(tx, job, null));
      expect(page.next).toBeNull();
      for (const id of originals)
        expect(page.changes.find((row) => row.original === id)).toEqual({
          original: id,
          previousTerminal: original,
          terminal: id === original ? terminal : remainder,
        });
      expect(page.changes.find((row) => row.original === terminal)).toEqual({
        original: terminal,
        previousTerminal: terminal,
        terminal,
      });
      const progress = await f.drainMapping(job, 512);
      const final = progress.at(-1)!;
      for (const row of progress) {
        expect(row.work.rows).toBeLessThanOrEqual(100);
        expect(row.frontier.after.length).toBeLessThanOrEqual(8);
        expect(Buffer.byteLength(JSON.stringify(row.frontier))).toBeLessThanOrEqual(2048);
      }
      expect(await f.nativeDirectRedirect(original)).toBe(terminal);
      expect(await f.nativeDirectRedirect(remainder)).toBeNull();
      for (const id of remaining.slice(1)) expect(await f.nativeDirectRedirect(id)).toBe(remainder);
      if (!terminalLast) {
        const hidden = (
          await f.admin.query(
            'SELECT visibility,security_revision FROM semantic.subject WHERE route=$1 AND subject_id=$2',
            [sourceRoute, remainder],
          )
        ).rows[0]!;
        expect(hidden).toEqual({ visibility: 'hidden', security_revision: '1' });
        expect(
          (
            await f.admin.query('SELECT visible FROM semantic.partition_subjects WHERE partition_no=$1', [
              sourceRoute >> 4,
            ])
          ).rows[0]!.visible,
        ).toBe('0');
      }
      const current = (
        await f.admin.query(
          `SELECT terminal,observed_count FROM semantic.identity_epoch_group
        WHERE partition_no=$1 AND terminal=ANY($2::uuid[]) ORDER BY terminal`,
          [sourceRoute >> 4, [original, remainder]],
        )
      ).rows;
      expect(current.find((row) => row.terminal === original)?.observed_count).toBe('0');
      expect(current.find((row) => row.terminal === remainder)?.observed_count).toBe('2');
      const members = (
        await f.admin.query(
          'SELECT member_id FROM semantic.merge_member WHERE route=$1 AND subject_id=$2 ORDER BY member_id',
          [routeOf(remainder), remainder],
        )
      ).rows.map((row) => row.member_id);
      expect(members).toEqual(remaining.slice(1));
      const native = await f.nativeRows(job);
      expect(native.effects.length).toBeGreaterThan(0);
      expect(native.custody).toHaveLength(native.effects.length);
      for (const effect of native.effects) {
        expect(effect.same_transaction).toBe(true);
        expect(native.custody.find((row) => row.effect_key === String(effect.unit))).toMatchObject({
          native_partition: effect.partition_no,
          native_transaction_id: effect.transaction_id,
          native_epoch: effect.epoch,
          native_position: effect.position,
        });
      }
      expect(await identityEpochStore().reconcileStepReceipt(f.pool, final.receipt)).toEqual(final);
      const beforeReplay = await f.snapshot([...originals, terminal]);
      expect(await stepIdentityEpochMapping(f.pool, job)).toEqual(final);
      expect(await f.snapshot([...originals, terminal])).toEqual(beforeReplay);
      await expect(f.publish(job)).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
      expect(f.operationBackendIds().size).toBeLessThanOrEqual(1);
    } finally {
      await f.close();
    }
  }, 180_000);
}

test('singleton terminal repoint has no remainder and preserves its public intent', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const original = (await f.create('Singleton source', 0xb180)).subject.id;
    const terminal = (await f.create('Singleton destination', 0xb190)).subject.id;
    const intent = { kind: 'repoint' as const, original, terminal, release: release.digest };
    const job = await f.admit(intent);
    const saved = (
      await f.admin.query(
        'SELECT intent,remainder_terminal FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2',
        [identityJobPartition(job), job.jobId],
      )
    ).rows[0]!;
    expect(saved.intent).toEqual(intent);
    expect(saved.remainder_terminal).toBeNull();
    await f.drainMapping(job, 256);
    expect(await f.nativeDirectRedirect(original)).toBe(terminal);
    expect(await f.nativeDirectRedirect(terminal)).toBeNull();
    const outputs = (await f.nativeRows(job)).head.outputs;
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ terminal, count: 2 });
  } finally {
    await f.close();
  }
}, 180_000);

test('self repoint rejects before native binding or mapping effects', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const original = (await f.create('Invalid self target', 0xb1c0)).subject.id;
    const before = await f.snapshot([original]);
    const bindings = (await f.admin.query('SELECT count(*) n FROM semantic.identity_epoch_receipt_binding')).rows[0]!.n;
    await expect(
      f.admit({ kind: 'repoint', original, terminal: original, release: release.digest }),
    ).rejects.toMatchObject({
      code: 'identity_effect_stale',
    });
    expect(await f.snapshot([original])).toEqual(before);
    expect((await f.admin.query('SELECT count(*) n FROM semantic.identity_epoch_receipt_binding')).rows[0]!.n).toBe(
      bindings,
    );
  } finally {
    await f.close();
  }
}, 180_000);
