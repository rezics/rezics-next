import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createOwnCountedVoteReader } from '../../src/rating/own-votes-counted.ts';
import { createVoteCommands, STANDARD_QUESTION_ID, type VoteReviewGuard } from '../../src/rating/votes.ts';
import { admitIdentityRatingEffect } from '../../src/semantic/identity-rating-admission.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { createSourceStatisticLifecycleFixture, type SourceStatisticLifecycleFixture } from './source-statistic-lifecycle-fixture.ts';

let fixture: SourceStatisticLifecycleFixture;
let actor: AccountActor;
let commands: ReturnType<typeof createVoteCommands>;
beforeAll(async () => {
  fixture = await createSourceStatisticLifecycleFixture();
  actor = (await fixture.identityCommand('rating:vote')).actor;
  commands = createVoteCommands({ pool: fixture.database.pool, access: fixture.access });
}, 180_000);
afterAll(async () => { await fixture?.close(); }, 180_000);

async function review(targetId: string) {
  const reader = createOwnCountedVoteReader({ pool: fixture.database.pool, access: fixture.access });
  const request = { actor, targetIds: [targetId] };
  const deadline = Date.now() + 60_000;
  const prepared = await reader.prepare(request, deadline);
  if (prepared.status !== 'prepared') throw new Error(JSON.stringify(prepared));
  const rows = await withReadTransaction(fixture.database.pool, (client) => reader.read(client, request, prepared.preparation), deadline);
  const result = await reader.finish(request, prepared.preparation, rows, deadline);
  if (result.status !== 'current' || result.observations[0]?.state === 'unavailable') throw new Error(JSON.stringify(result));
  return result.observations[0]!.review;
}
const input = (targetId: string, units: number | null, guard?: VoteReviewGuard) => ({
  questionId: STANDARD_QUESTION_ID, targetId, units, ...(guard ? { guard } : {}),
});
async function snapshot() {
  return (await fixture.database.admin.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(v) ORDER BY target_id) FROM rating.vote v WHERE voter_id=$1) AS votes,
    (SELECT count(*)::int FROM core.receipt WHERE command_kind='rating.vote.put' AND principal_id=$1) AS receipts,
    (SELECT count(*)::int FROM core.outbox WHERE type='com.rezics.rating.vote.changed.v1') AS events,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY route, question_id, population_id, target_id, shard) FROM rating.aggregate_component a) AS aggregates`, [actor.accountId])).rows[0];
}
async function refused(target: string, units: number | null, guard: VoteReviewGuard, reason: string, key = crypto.randomUUID()) {
  const before = await snapshot();
  await expect(commands.putVoteOutcome(actor, input(target, units, guard), key)).rejects.toMatchObject({ reason });
  expect(await snapshot()).toEqual(before);
}

test('native absence and matching no-op remain unavailable without atomic owner fences; unchanged retries have no effects', async () => {
  const target = await fixture.createSubject();
  const guard = await review(target);
  expect(guard.ownVote.state).toBe('absent');
  expect(JSON.parse(guard.ownVote.observation).slice(5)).toEqual([null, null, null]);
  const key = crypto.randomUUID();
  await refused(target, null, guard, 'atomic_guard_unavailable', key);
  await refused(target, null, guard, 'atomic_guard_unavailable', key);
  const written = await commands.putVoteOutcome(actor, input(target, 0), key);
  expect(written.vote).toMatchObject({ units: 0, revision: 1 });
  expect(written.component).not.toBeNull();
  await refused(target, 0, await review(target), 'atomic_guard_unavailable');
  await refused(target, 4, guard, 'own_vote_changed');
  expect(await commands.putVoteOutcome(actor, input(target, 0), crypto.randomUUID())).toEqual({ vote: written.vote, component: null });
}, 180_000);

test('native write, clear, zero and ABA change the exact witness even when displayed units match', async () => {
  const target = await fixture.createSubject();
  await commands.putVoteOutcome(actor, input(target, 0), crypto.randomUUID());
  const zero = await review(target);
  expect(zero.ownVote.state).toBe('present');
  await commands.putVoteOutcome(actor, input(target, null), crypto.randomUUID());
  const clear = await review(target);
  expect(clear.ownVote.state).toBe('present');
  expect(JSON.parse(clear.ownVote.observation)[7][1]).toBeNull();
  await refused(target, 3, zero, 'own_vote_changed');
  await commands.putVoteOutcome(actor, input(target, 0), crypto.randomUUID());
  expect((await review(target)).ownVote.observation).not.toBe(zero.ownVote.observation);
  await refused(target, 3, zero, 'own_vote_changed');
  await refused(target, 3, clear, 'own_vote_changed');
}, 180_000);

test('native receipts preserve unconditional replay and reject a different normalized guard on the same key', async () => {
  const target = await fixture.createSubject();
  const guard = await review(target);
  const key = crypto.randomUUID();
  const original = await commands.putVoteOutcome(actor, input(target, 7), key);
  await commands.putVoteOutcome(actor, input(target, 9), crypto.randomUUID());
  expect(await commands.putVoteOutcome(actor, input(target, 7), key)).toEqual(original);
  const before = await snapshot();
  await expect(commands.putVoteOutcome(actor, input(target, 7, guard), key)).rejects.toMatchObject({ name: 'IdempotencyConflictError' });
  expect(await snapshot()).toEqual(before);
}, 180_000);

test('native published epochs compare exact values, and malformed evidence never becomes unconditional', async () => {
  const target = await fixture.createSubject();
  const guard = await review(target);
  expect(await withReadTransaction(fixture.database.pool, (tx) => admitIdentityRatingEffect(tx, {
    requestedTargetId: target, resolvedTargetId: target, expectedEpochs: guard.subject.epochs,
  }))).toMatchObject({ status: 'admitted' });
  const changed: VoteReviewGuard = { ...guard, subject: {
    ...guard.subject, epochs: guard.subject.epochs.map((epoch) => ({ ...epoch, epoch: (BigInt(epoch.epoch) + 1n).toString() })),
  } };
  await expect(withReadTransaction(fixture.database.pool, (tx) => admitIdentityRatingEffect(tx, {
    requestedTargetId: target, resolvedTargetId: target, expectedEpochs: changed.subject.epochs,
  }))).rejects.toMatchObject({ code: 'vote_review_stale', reason: 'identity_epoch_changed' });
  await refused(target, 5, changed, 'identity_epoch_changed');
  for (const invalid of [
    { ...guard, version: 2 }, { ...guard, extra: true },
    { ...guard, subject: { ...guard.subject, epochs: [] } },
    { ...guard, ownVote: { state: 'absent', observation: 'x'.repeat(4097) } },
  ]) {
    await expect(commands.putVoteOutcome(actor, input(target, 4, invalid as VoteReviewGuard), crypto.randomUUID())).rejects.toMatchObject({ name: 'VoteInvalidError', field: 'guard' });
  }
}, 180_000);
