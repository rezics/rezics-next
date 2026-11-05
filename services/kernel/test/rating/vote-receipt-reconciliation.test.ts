import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createVoteCommands, STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { routeOf } from '../../src/route/route.ts';
import {
  createSourceStatisticLifecycleFixture,
  type SourceStatisticLifecycleFixture,
} from './source-statistic-lifecycle-fixture.ts';

let fixture: SourceStatisticLifecycleFixture;
let actor: AccountActor;
let commands: ReturnType<typeof createVoteCommands>;
beforeAll(async () => {
  fixture = await createSourceStatisticLifecycleFixture();
  actor = (await fixture.identityCommand('rating:vote')).actor;
  commands = createVoteCommands({ pool: fixture.database.pool, access: fixture.access });
}, 180_000);
afterAll(async () => fixture?.close(), 180_000);
const input = (targetId: string, units = 7) => ({ questionId: STANDARD_QUESTION_ID, targetId, units });
async function snapshot() {
  return (
    await fixture.database.admin.query(
      `SELECT
    (SELECT jsonb_agg(to_jsonb(v)) FROM rating.vote v WHERE voter_id=$1) AS votes,
    (SELECT jsonb_agg(to_jsonb(a)) FROM rating.aggregate_component a) AS aggregates,
    (SELECT count(*)::int FROM core.outbox) AS events,
    (SELECT count(*)::int FROM core.receipt) AS receipts`,
      [actor.accountId],
    )
  ).rows[0];
}

test('native receipt survives scrubbed input, changed own score and question business revisions; readback stays current', async () => {
  const targetId = await fixture.createSubject();
  const question = await commands.readRatingQuestion(actor, STANDARD_QUESTION_ID);
  const prepared = commands.preparePutVote(
    actor,
    {
      ...input(targetId),
      observation: {
        subjectId: targetId,
        question: {
          id: question.id,
          revision: question.revision,
          grain: question.grain,
          meaning: question.meaning ?? question.label,
          scale: { min: question.minimumUnits, max: question.maximumUnits, displayStep: question.stepUnits },
        },
      },
    },
    crypto.randomUUID(),
  );
  const original = await commands.putVoteOutcome(actor, prepared.input, prepared.receipt.requestKey);
  expect(original.component).not.toBeNull();
  const stored = (
    await fixture.database.admin.query('SELECT request_digest FROM core.receipt WHERE transaction_id=$1', [
      original.vote!.transactionId,
    ])
  ).rows[0];
  expect(stored.request_digest.toString('hex')).toBe(prepared.receipt.digest);
  const retained = JSON.parse(JSON.stringify(prepared.receipt));
  expect(Object.keys(retained).sort()).toEqual(['digest', 'questionId', 'requestKey', 'targetId']);
  await commands.putVoteOutcome(actor, input(targetId, 9), crypto.randomUUID());
  await fixture.database.admin.query('UPDATE rating.question SET revision=revision+1, maximum_units=6 WHERE id=$1', [
    STANDARD_QUESTION_ID,
  ]);
  try {
    const before = await snapshot();
    expect(await commands.reconcilePutVote(actor, retained)).toEqual(original);
    expect(await snapshot()).toEqual(before);
    expect(await commands.readOwnVote(actor, STANDARD_QUESTION_ID, targetId)).toMatchObject({ units: 9, revision: 2 });
  } finally {
    await fixture.database.admin.query('UPDATE rating.question SET revision=$2, maximum_units=$3 WHERE id=$1', [
      question.id,
      question.revision,
      question.maximumUnits,
    ]);
  }
}, 180_000);

test('native misses and unchanged commands have no receipt or effects; complete guarded inputs retain native conflicts', async () => {
  const target = await fixture.createSubject();
  const guard = (await commands.readVoteReview(actor, STANDARD_QUESTION_ID, target)).guard;
  const key = crypto.randomUUID();
  const guarded = commands.preparePutVote(actor, { ...input(target), guard }, key);
  expect(Object.isFrozen(guarded.input.guard!.subject.epochs)).toBe(true);
  const before = await snapshot();
  expect(await commands.reconcilePutVote(actor, guarded.receipt)).toBeNull();
  expect(await snapshot()).toEqual(before);
  const original = await commands.putVoteOutcome(actor, input(target), key);
  const unchanged = commands.preparePutVote(actor, input(target), crypto.randomUUID());
  expect(await commands.putVoteOutcome(actor, unchanged.input, unchanged.receipt.requestKey)).toEqual({
    vote: original.vote,
    component: null,
  });
  const after = await snapshot();
  expect(await commands.reconcilePutVote(actor, unchanged.receipt)).toBeNull();
  for (const changed of [guarded, commands.preparePutVote(actor, input(target, 8), key)]) {
    await expect(commands.reconcilePutVote(actor, changed.receipt)).rejects.toMatchObject({
      name: 'IdempotencyConflictError',
    });
    await expect(commands.putVoteOutcome(actor, changed.input, key)).rejects.toMatchObject({
      name: 'IdempotencyConflictError',
    });
  }
  expect(await snapshot()).toEqual(after);
}, 180_000);

test('current scope, account, Access and Subject exposure precede receipt disclosure and misses', async () => {
  const target = await fixture.createSubject();
  const prepared = commands.preparePutVote(actor, input(target), crypto.randomUUID());
  const original = await commands.putVoteOutcome(actor, prepared.input, prepared.receipt.requestKey);
  for (const receipt of [prepared.receipt, { ...prepared.receipt, requestKey: crypto.randomUUID() }]) {
    await expect(commands.reconcilePutVote({ ...actor, scopes: [] }, receipt)).rejects.toMatchObject({
      name: 'GrantDeniedError',
    });
    await fixture.revokeWriter();
    try {
      await expect(commands.reconcilePutVote(actor, receipt)).rejects.toThrow();
    } finally {
      await fixture.restoreWriter();
    }
    await fixture.database.admin.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE account_id=$1', [
      actor.accountId,
    ]);
    try {
      await expect(commands.reconcilePutVote(actor, receipt)).rejects.toThrow();
    } finally {
      await fixture.database.admin.query('UPDATE access.account SET minimum_authn_epoch=1 WHERE account_id=$1', [
        actor.accountId,
      ]);
    }
    await fixture.database.admin.query(
      `INSERT INTO access.resource_denial
      (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
      VALUES ($1,$2,$3,'','subject:read','resource','(,)', $4)`,
      [routeOf(target), target, actor.accountId, crypto.randomUUID()],
    );
    try {
      await expect(commands.reconcilePutVote(actor, receipt)).rejects.toThrow();
    } finally {
      await fixture.database.admin.query('DELETE FROM access.resource_denial WHERE resource_id=$1 AND subject_id=$2', [
        target,
        actor.accountId,
      ]);
    }
  }
  expect(await commands.reconcilePutVote(actor, prepared.receipt)).toEqual(original);
}, 180_000);
