import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createAccess } from '../../src/access/permission.ts';
import type { Account } from '../../src/access/account-data.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { EVENT_TYPES } from '../../src/events/catalogue.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createVoteCommands, STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x3a01;
const eventType = 'com.rezics.rating.vote.changed.v1';
const routeKey = new Uint8Array(32).fill(73);
const scopes = ['subject:read', 'rating:vote'];
const actorFor = (accountId: string, permissions = scopes): AccountActor => ({
  kind: 'account',
  accountId,
  scopes: permissions,
  clientId: 'rating-votes-test',
  requestedBy: null,
  authnEpoch: 1,
});
const voter = actorFor(newId(route));
const other = actorFor(newId(route));
const noScope = actorFor(newId(route), ['subject:read']);
const clock = () => new Date('2026-10-27T10:00:00.000Z');
let database: GrowthDatabase;
let commands: ReturnType<typeof createVoteCommands>;
let subjectId: string;
let unreadableSubjectId: string;

async function createReadableSubject(actor: AccountActor, label: string): Promise<string> {
  const key = randomUUID();
  const result = await createSubject(database.pool, {
    actor,
    target: subjectTarget(routeKey, actor.accountId, key),
    idempotencyKey: key,
    digest: createHash('sha256').update(key).digest(),
    item: { type: 'schema:Book', labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return result.subject.id;
}

async function snapshot(accountId: string) {
  return (
    await database.admin.query(
      `SELECT
         (SELECT count(*)::int FROM rating.vote WHERE voter_id = $1) AS votes,
         (SELECT count(*)::int FROM core.outbox WHERE type = $2 AND subject = $1::text) AS events`,
      [accountId, eventType],
    )
  ).rows[0];
}

async function events(accountId: string) {
  const result = await database.admin.query<{ data: Record<string, unknown> }>(
    `SELECT data FROM core.outbox WHERE type = $1 AND subject = $2 ORDER BY position, event_seq`,
    [eventType, accountId],
  );
  return result.rows.map(({ data }) => data);
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  await bootstrapRelease(database.pool, bundledRelease);
  const accounts = new Map<string, Account>();
  for (const actor of [voter, other, noScope]) {
    await database.admin.query(
      `INSERT INTO access.account
         (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
       VALUES ($1, $2, 'actor', 'active', $3, false, 1)`,
      [route, actor.accountId, newId(route)],
    );
    accounts.set(actor.accountId, (await readAccount(database.pool, route, actor.accountId))!);
  }
  const access = createAccess({
    actions: new Map([['subject:read', { anonymous: true }]]),
    accountEvidence: (actor) => accounts.get(actor.accountId) ?? null,
  });
  commands = createVoteCommands({ pool: database.pool, access, clock });
  subjectId = await createReadableSubject(voter, 'Rating target');
  unreadableSubjectId = await createReadableSubject(voter, 'Unreadable rating target');
  await database.admin.query(
    `INSERT INTO access.resource_denial
       (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
     VALUES ($1, $2, $3, '', 'subject:read', 'resource', '(,)'::tstzrange, $4)`,
    [routeOf(unreadableSubjectId), unreadableSubjectId, voter.accountId, newId(route)],
  );
});

afterAll(async () => {
  if (database) await database.close();
});

test('one account has one current vote per question and target in its own partition with an increasing revision', async () => {
  expect(EVENT_TYPES[eventType]).toBeDefined();
  const first = await commands.putVote(
    voter,
    { questionId: STANDARD_QUESTION_ID, targetId: subjectId, units: 7 },
    randomUUID(),
  );
  expect(first).toMatchObject({
    voterId: voter.accountId,
    questionId: STANDARD_QUESTION_ID,
    targetId: subjectId,
    units: 7,
    revision: 1,
  });
  expect(partitionOf(routeOf(voter.accountId)!)).toBe(partitionOf(route));
  expect(await commands.readOwnVote(voter, STANDARD_QUESTION_ID, subjectId)).toEqual(first);
  expect(await commands.readOwnVote(other, STANDARD_QUESTION_ID, subjectId)).toBeNull();

  const changed = await commands.putVote(
    voter,
    { questionId: STANDARD_QUESTION_ID, targetId: subjectId, units: 8 },
    randomUUID(),
  );
  expect(changed).toMatchObject({
    voterId: voter.accountId,
    questionId: STANDARD_QUESTION_ID,
    targetId: subjectId,
    units: 8,
    revision: 2,
  });
  expect(
    await commands.putVote(other, { questionId: STANDARD_QUESTION_ID, targetId: subjectId, units: 9 }, randomUUID()),
  ).toMatchObject({
    voterId: other.accountId,
    units: 9,
    revision: 1,
  });
  const rows = await database.admin.query(
    `SELECT route, voter_id AS "voterId", question_id AS "questionId", target_id AS "targetId", units, revision
       FROM rating.vote WHERE voter_id = $1 AND question_id = $2 AND target_id = $3`,
    [voter.accountId, STANDARD_QUESTION_ID, subjectId],
  );
  expect(rows.rows).toEqual([
    {
      route,
      voterId: voter.accountId,
      questionId: STANDARD_QUESTION_ID,
      targetId: subjectId,
      units: 8,
      revision: 2,
    },
  ]);
  expect(await commands.readOwnVote(other, STANDARD_QUESTION_ID, subjectId)).toMatchObject({
    voterId: other.accountId,
    units: 9,
  });
});

test('invalid units, unreadable or unknown subjects, and missing vote scope are refused without writes', async () => {
  const before = await snapshot(voter.accountId);
  const unknown = newId(route);
  for (const attempt of [
    () => commands.putVote(voter, { questionId: STANDARD_QUESTION_ID, targetId: subjectId, units: 21 }, randomUUID()),
    () =>
      commands.putVote(
        voter,
        { questionId: STANDARD_QUESTION_ID, targetId: unreadableSubjectId, units: 8 },
        randomUUID(),
      ),
    () => commands.putVote(voter, { questionId: STANDARD_QUESTION_ID, targetId: unknown, units: 8 }, randomUUID()),
    () => commands.putVote(noScope, { questionId: STANDARD_QUESTION_ID, targetId: subjectId, units: 8 }, randomUUID()),
  ]) {
    await expect(attempt()).rejects.toBeDefined();
  }
  expect(await snapshot(voter.accountId)).toEqual(before);
});

test('clearing keeps a tombstone and idempotent changes emit no event', async () => {
  const absentTarget = await createReadableSubject(voter, 'Absent vote target');
  const before = await snapshot(voter.accountId);
  await commands.putVote(
    voter,
    { questionId: STANDARD_QUESTION_ID, targetId: absentTarget, units: null },
    randomUUID(),
  );
  expect(await snapshot(voter.accountId)).toEqual(before);

  const first = await commands.putVote(
    voter,
    { questionId: STANDARD_QUESTION_ID, targetId: subjectId, units: 5 },
    randomUUID(),
  );
  if (!first) throw new Error('Expected a stored vote');
  const afterFirst = await snapshot(voter.accountId);
  const repeated = await commands.putVote(
    voter,
    { questionId: STANDARD_QUESTION_ID, targetId: subjectId, units: 5 },
    randomUUID(),
  );
  expect(repeated).toEqual(first);
  expect(await snapshot(voter.accountId)).toEqual(afterFirst);

  const cleared = await commands.putVote(
    voter,
    { questionId: STANDARD_QUESTION_ID, targetId: subjectId, units: null },
    randomUUID(),
  );
  expect(cleared).toMatchObject({ units: null, revision: first.revision + 1 });
  const afterClear = await snapshot(voter.accountId);
  await commands.putVote(voter, { questionId: STANDARD_QUESTION_ID, targetId: subjectId, units: null }, randomUUID());
  expect(await snapshot(voter.accountId)).toEqual(afterClear);
  expect(await commands.readOwnVote(voter, STANDARD_QUESTION_ID, subjectId)).toEqual(cleared);
});

test('each real change emits the previous and new units, revision and Global population', async () => {
  const targetId = await createReadableSubject(voter, 'Vote event target');
  const first = await commands.putVote(voter, { questionId: STANDARD_QUESTION_ID, targetId, units: 3 }, randomUUID());
  const second = await commands.putVote(voter, { questionId: STANDARD_QUESTION_ID, targetId, units: 4 }, randomUUID());
  const cleared = await commands.putVote(
    voter,
    { questionId: STANDARD_QUESTION_ID, targetId, units: null },
    randomUUID(),
  );
  if (!first || !second || !cleared) throw new Error('Expected each changed vote to remain stored');
  expect(await events(voter.accountId)).toContainEqual({
    voterId: voter.accountId,
    questionId: STANDARD_QUESTION_ID,
    targetId,
    previous: null,
    units: 3,
    revision: first.revision,
    populations: [GLOBAL_CONTEXT.id],
  });
  expect(await events(voter.accountId)).toContainEqual({
    voterId: voter.accountId,
    questionId: STANDARD_QUESTION_ID,
    targetId,
    previous: 3,
    units: 4,
    revision: second.revision,
    populations: [GLOBAL_CONTEXT.id],
  });
  expect(await events(voter.accountId)).toContainEqual({
    voterId: voter.accountId,
    questionId: STANDARD_QUESTION_ID,
    targetId,
    previous: 4,
    units: null,
    revision: cleared.revision,
    populations: [GLOBAL_CONTEXT.id],
  });
});
