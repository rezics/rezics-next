import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createVoteCommands, STANDARD_QUESTION_ID, type VoteReviewGuard } from '../../src/rating/votes.ts';
import { admitIdentityRatingEffect } from '../../src/semantic/identity-rating-admission.ts';
import { withReadTransaction } from '../../src/access/read-transaction.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { subjectTarget } from '../../src/semantic/subject.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { installIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap-install.ts';
import { stepIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap.ts';
import {
  createSourceStatisticLifecycleFixture,
  type SourceStatisticLifecycleFixture,
} from './source-statistic-lifecycle-fixture.ts';

let fixture: SourceStatisticLifecycleFixture;
let actor: AccountActor;
let commands: ReturnType<typeof createVoteCommands>;
beforeAll(async () => {
  fixture = await createSourceStatisticLifecycleFixture();
  await installIdentityEpochBootstrap(fixture.database.pool);
  actor = (await fixture.identityCommand('rating:vote')).actor;
  commands = createVoteCommands({ pool: fixture.database.pool, access: fixture.access });
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

async function reviewOutput(targetId: string) {
  await bootstrap(fixture, targetId);
  return commands.readVoteReview(actor, STANDARD_QUESTION_ID, targetId);
}
async function bootstrap(f: SourceStatisticLifecycleFixture, targetId: string) {
  const home = partitionOf(routeOf(targetId)!);
  for (let page = 0; page < 1000; page++) {
    if ((await stepIdentityEpochBootstrap(f.database.pool, home)).state === 'caught-up') return;
  }
  throw new Error('Native identity bootstrap did not finish');
}
async function review(targetId: string) {
  return (await reviewOutput(targetId)).guard;
}
const input = (targetId: string, units: number | null, guard?: VoteReviewGuard) => ({
  questionId: STANDARD_QUESTION_ID,
  targetId,
  units,
  ...(guard ? { guard } : {}),
});
async function snapshot() {
  return (
    await fixture.database.admin.query(
      `SELECT
    (SELECT jsonb_agg(to_jsonb(v) ORDER BY target_id) FROM rating.vote v WHERE voter_id=$1) AS votes,
    (SELECT count(*)::int FROM core.receipt WHERE command_kind='rating.vote.put' AND principal_id=$1) AS receipts,
    (SELECT count(*)::int FROM core.outbox WHERE type='com.rezics.rating.vote.changed.v1') AS events,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY route, question_id, population_id, target_id, shard) FROM rating.aggregate_component a) AS aggregates`,
      [actor.accountId],
    )
  ).rows[0];
}
async function refused(
  target: string,
  units: number | null,
  guard: VoteReviewGuard,
  reason: string,
  key = crypto.randomUUID(),
) {
  const before = await snapshot();
  await expect(commands.putVoteOutcome(actor, input(target, units, guard), key)).rejects.toMatchObject({ reason });
  expect(await snapshot()).toEqual(before);
}

test('foreign question/source homes remain unavailable; unchanged retries have no effects', async () => {
  const target = await fixture.createSubject();
  const reviewed = await reviewOutput(target);
  const guard = reviewed.guard;
  expect(reviewed.question).toMatchObject({ id: STANDARD_QUESTION_ID, revision: 1 });
  expect(reviewed.currentVote.state).toBe('absent');
  expect(reviewed.currentVote.review).toBe(guard);
  expect(Object.isFrozen(guard)).toBe(true);
  expect(Object.isFrozen(guard.question)).toBe(true);
  expect(Object.isFrozen(guard.subject.epochs)).toBe(true);
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
  expect(await commands.putVoteOutcome(actor, input(target, 0), crypto.randomUUID())).toEqual({
    vote: written.vote,
    component: null,
  });
}, 180_000);

test('supported native guarded effects retain exact retries, current readback and no-op semantics', async () => {
  const local = await createSourceStatisticLifecycleFixture({ accountRoute: 1 });
  try {
    await installIdentityEpochBootstrap(local.database.pool);
    const voter = (await local.identityCommand('rating:vote')).actor;
    const votes = createVoteCommands({ pool: local.database.pool, access: local.access });
    // Select an ordinary native creation key; do not rewrite a Subject or its home.
    async function createLocalSubject() {
      let key = crypto.randomUUID();
      while (partitionOf(subjectTarget(local.routeKey, voter.accountId, key).route) !== 0) key = crypto.randomUUID();
      const target = await local.createSubject(undefined, key);
      await bootstrap(local, target);
      return target;
    }
    const target = await createLocalSubject();
    const before = await votes.readVoteReview(voter, STANDARD_QUESTION_ID, target);
    expect(before.guard.subject.identity).toMatchObject({
      version: 1,
      requestedOriginalId: target,
      canonicalTerminalId: target,
      sourceHomes: [0],
    });
    expect(Object.isFrozen(before.guard.subject.identity!.controlLocators)).toBe(true);
    expect(await votes.putVoteOutcome(voter, input(target, null, before.guard), crypto.randomUUID())).toEqual({
      vote: null,
      component: null,
    });
    const legacy = { ...before.guard, subject: { canonicalId: target, epochs: before.guard.subject.epochs } };
    await expect(votes.putVoteOutcome(voter, input(target, 0, legacy), crypto.randomUUID())).rejects.toMatchObject({
      reason: 'atomic_guard_unavailable',
    });
    const prepared = votes.preparePutVote(voter, input(target, 0, before.guard), crypto.randomUUID());
    const storedGuard = (await local.database.admin.query('SELECT $1::jsonb AS guard', [JSON.stringify(before.guard)]))
      .rows[0].guard;
    expect(votes.preparePutVote(voter, input(target, 0, storedGuard), prepared.receipt.requestKey)).toEqual(prepared);
    const committed = await votes.putVoteOutcome(voter, input(target, 0, storedGuard), prepared.receipt.requestKey);
    expect(committed.vote).toMatchObject({ units: 0, revision: 1 });
    expect(committed.component).not.toBeNull();
    const current = await votes.readVoteReview(voter, STANDARD_QUESTION_ID, target);
    expect(current.currentVote).toMatchObject({ state: 'counted', units: 0, countedRevision: 1 });
    expect(await votes.putVoteOutcome(voter, input(target, 0, current.guard), crypto.randomUUID())).toEqual({
      vote: committed.vote,
      component: null,
    });
    const cleared = await votes.putVoteOutcome(voter, input(target, null, current.guard), crypto.randomUUID());
    expect(cleared.vote?.units).toBeNull();
    expect((await votes.readVoteReview(voter, STANDARD_QUESTION_ID, target)).currentVote.state).toBe('clear');
    // An uncertain retry uses precisely the original input/key after business state changes.
    expect(await votes.putVoteOutcome(voter, prepared.input, prepared.receipt.requestKey)).toEqual(committed);
    expect(await votes.reconcilePutVote(voter, prepared.receipt)).toEqual(committed);
    await expect(
      votes.putVoteOutcome(voter, input(target, 0, current.guard), prepared.receipt.requestKey),
    ).rejects.toMatchObject({ name: 'IdempotencyConflictError' });
    await expect(
      votes.putVoteOutcome(voter, input(target, 5, before.guard), crypto.randomUUID()),
    ).rejects.toMatchObject({ reason: 'own_vote_changed' });
    const competing = await createLocalSubject();
    const absent = await votes.readVoteReview(voter, STANDARD_QUESTION_ID, competing);
    const own = await votes.readVoteReview(voter, STANDARD_QUESTION_ID, target);
    await expect(
      votes.putVoteOutcome(
        voter,
        input(target, 5, {
          ...own.guard,
          subject: { ...own.guard.subject, identity: absent.guard.subject.identity! },
        }),
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ name: 'VoteInvalidError', field: 'guard' });
    const writers = await Promise.allSettled(
      [3, 4].map((units) => votes.putVoteOutcome(voter, input(competing, units, absent.guard), crypto.randomUUID())),
    );
    expect(writers.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(writers.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      reason: { code: 'vote_review_stale', reason: 'own_vote_changed' },
    });
    const changed = await votes.readVoteReview(voter, STANDARD_QUESTION_ID, target);
    await local.database.admin.query('UPDATE rating.question SET revision=revision+1 WHERE id=$1', [
      STANDARD_QUESTION_ID,
    ]);
    try {
      expect(await votes.putVoteOutcome(voter, prepared.input, prepared.receipt.requestKey)).toEqual(committed);
      await expect(
        votes.putVoteOutcome(voter, input(target, 5, changed.guard), crypto.randomUUID()),
      ).rejects.toMatchObject({ reason: 'question_changed' });
      await local.database.admin.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE account_id=$1', [
        voter.accountId,
      ]);
      await expect(votes.reconcilePutVote(voter, prepared.receipt)).rejects.toMatchObject({ name: 'GrantDeniedError' });
    } finally {
      await local.database.admin.query('UPDATE rating.question SET revision=revision-1 WHERE id=$1', [
        STANDARD_QUESTION_ID,
      ]);
    }
  } finally {
    await local.close();
  }
}, 180_000);

test('native review export returns counted zero and clear through the bounded reader', async () => {
  const target = await fixture.createSubject();
  await commands.putVoteOutcome(actor, input(target, 0), crypto.randomUUID());
  expect(await reviewOutput(target)).toMatchObject({ currentVote: { state: 'counted', units: 0 } });
  await commands.putVoteOutcome(actor, input(target, null), crypto.randomUUID());
  expect(await reviewOutput(target)).toMatchObject({ currentVote: { state: 'clear', units: null } });
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
  await expect(commands.putVoteOutcome(actor, input(target, 7, guard), key)).rejects.toMatchObject({
    name: 'IdempotencyConflictError',
  });
  expect(await snapshot()).toEqual(before);
}, 180_000);

test('native published epochs compare exact values, and malformed evidence never becomes unconditional', async () => {
  const target = await fixture.createSubject();
  const guard = await review(target);
  expect(
    await withReadTransaction(fixture.database.pool, (tx) =>
      admitIdentityRatingEffect(tx, {
        requestedTargetId: target,
        resolvedTargetId: target,
        expectedEpochs: guard.subject.epochs,
      }),
    ),
  ).toMatchObject({ status: 'admitted' });
  const changed: VoteReviewGuard = {
    ...guard,
    subject: {
      ...guard.subject,
      epochs: guard.subject.epochs.map((epoch) => ({ ...epoch, epoch: (BigInt(epoch.epoch) + 1n).toString() })),
    },
  };
  await expect(
    withReadTransaction(fixture.database.pool, (tx) =>
      admitIdentityRatingEffect(tx, {
        requestedTargetId: target,
        resolvedTargetId: target,
        expectedEpochs: changed.subject.epochs,
      }),
    ),
  ).rejects.toMatchObject({ code: 'vote_review_stale', reason: 'identity_epoch_changed' });
  await refused(target, 5, changed, 'identity_epoch_changed');
  for (const invalid of [
    { ...guard, version: 2 },
    { ...guard, extra: true },
    { ...guard, subject: { ...guard.subject, epochs: [] } },
    { ...guard, ownVote: { state: 'absent', observation: 'x'.repeat(4097) } },
  ]) {
    await expect(
      commands.putVoteOutcome(actor, input(target, 4, invalid as VoteReviewGuard), crypto.randomUUID()),
    ).rejects.toMatchObject({ name: 'VoteInvalidError', field: 'guard' });
  }
}, 180_000);
