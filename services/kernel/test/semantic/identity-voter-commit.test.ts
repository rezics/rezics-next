import { expect, test } from 'bun:test';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { readIdentityRatingReview } from '../../src/semantic/identity-adapters/read.ts';
import { createIdentityRatingCommitParticipant } from '../../src/semantic/identity-rating-commit-participant.ts';
import { createIdentityMappingFixture } from './support/identity-epoch-mapping.ts';
import { release } from './support/identity-epoch.ts';

async function reviewedSelf(f: Awaited<ReturnType<typeof createIdentityMappingFixture>>, route: number) {
  const subjectId = (await f.create('Rating reviewed identity', route)).subject.id;
  await f.bootstrapHomes([subjectId]);
  const review = await readIdentityRatingReview(f.pool, {
    requestedOriginalId: subjectId,
    canonicalTerminalId: subjectId,
    deadline: Date.now() + 5000,
  });
  if (review.state !== 'reviewed') throw new Error(`Expected a reviewed self mapping, received ${review.state}`);
  return { subjectId, operand: review.operand, home: partitionOf(routeOf(subjectId)!) };
}

test('reviewed identity admission returns the native owner and published head and holds the owner fence through commit', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 2 });
  try {
    const selected = await reviewedSelf(f, 0x5d10);
    const participant = createIdentityRatingCommitParticipant();
    const prepared = participant.prepare(selected.operand);
    let releaseCommand!: () => void;
    let admitted!: (held: Awaited<ReturnType<typeof participant.admit>>) => void;
    const commandBarrier = new Promise<void>((resolve) => (releaseCommand = resolve));
    const admission = new Promise<Awaited<ReturnType<typeof participant.admit>>>((resolve) => (admitted = resolve));
    const command = runCommand(f.pool, { partition: selected.home, deadline: Date.now() + 10_000 }, async (tx) => {
      const held = await participant.admit(tx, prepared);
      admitted(held);
      await commandBarrier;
      return noEffect(held);
    });
    const held = await admission;
    const expectedOwner = (
      await f.admin.query('SELECT node,epoch FROM core.partition WHERE partition_no=$1', [selected.home])
    ).rows[0]!;
    const expectedHead = (
      await f.admin.query(
        'SELECT published_epoch FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=$2',
        [selected.home, selected.subjectId],
      )
    ).rows[0]!;
    expect(held).toEqual({
      ownerId: expectedOwner.node,
      ownerEpoch: expectedOwner.epoch,
      partition: selected.home,
      subjectId: selected.subjectId,
      publishedHeads: [
        { partition: selected.home, group: selected.subjectId, epoch: String(expectedHead.published_epoch) },
      ],
    });

    const writer = await f.admin.connect();
    try {
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout = '100ms'");
      await expect(
        writer.query('UPDATE core.partition SET position=position+1 WHERE partition_no=$1', [selected.home]),
      ).rejects.toMatchObject({ code: '55P03' });
      await writer.query('ROLLBACK');
      releaseCommand();
      expect((await command).value).toEqual(held);
      const afterCommit = await writer.query(
        'UPDATE core.partition SET position=position+1 WHERE partition_no=$1 RETURNING partition_no',
        [selected.home],
      );
      expect(afterCommit.rowCount).toBe(1);
    } finally {
      releaseCommand();
      writer.release();
    }
  } finally {
    await f.close();
  }
}, 180_000);

test('identity mutation after review refuses admission, and rollback releases the native fence', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 2 });
  try {
    const original = (await f.create('Rating original', 0x5d10)).subject.id;
    const survivor = (await f.create('Rating survivor', 0x5d10)).subject.id;
    await f.bootstrapHomes([original, survivor]);
    const review = await readIdentityRatingReview(f.pool, {
      requestedOriginalId: original,
      canonicalTerminalId: original,
      deadline: Date.now() + 5000,
    });
    if (review.state !== 'reviewed') throw new Error(`Expected a reviewed self mapping, received ${review.state}`);
    const participant = createIdentityRatingCommitParticipant();
    const prepared = participant.prepare(review.operand);
    await expect(
      runCommand(f.pool, { partition: partitionOf(routeOf(original)!) }, async (tx) => {
        await participant.admit(tx, prepared);
        throw new Error('rollback after identity admission');
      }),
    ).rejects.toThrow('rollback after identity admission');

    await f.admit({ kind: 'merge', redirected: original, survivor, release: release.digest });

    await expect(
      runCommand(f.pool, { partition: partitionOf(routeOf(original)!) }, async (tx) =>
        noEffect(await participant.admit(tx, prepared)),
      ),
    ).rejects.toMatchObject({
      name: 'IdentityRatingCommitUnavailableError',
      identityState: 'pending',
    });

    const current = await readIdentityRatingReview(f.pool, {
      requestedOriginalId: original,
      canonicalTerminalId: original,
      deadline: Date.now() + 5000,
    });
    expect(current.state).toBe('pending');
  } finally {
    await f.close();
  }
}, 180_000);

test('preparation rejects extra, duplicated and oversized reviewed evidence', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const selected = await reviewedSelf(f, 0x5d10);
    const participant = createIdentityRatingCommitParticipant();
    expect(() => participant.prepare({ ...selected.operand, extra: true } as never)).toThrow(TypeError);
    expect(() =>
      participant.prepare({
        ...selected.operand,
        controlLocators: [...selected.operand.controlLocators, selected.operand.controlLocators[0]!],
      }),
    ).toThrow(TypeError);
    expect(() =>
      participant.prepare({
        ...selected.operand,
        evidence: JSON.stringify({ mapping: 'x'.repeat(16_500), subjects: [] }),
      }),
    ).toThrow(TypeError);
  } finally {
    await f.close();
  }
}, 180_000);
