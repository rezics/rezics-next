import { afterAll, beforeAll, expect, expectTypeOf, spyOn, test } from 'bun:test';
import type { OwnVoteActions, OwnVoteEntry, OwnVotesPage, OwnVotesPageQuery } from '@rezics/client';
import { STANDARD_QUESTION_ID, VoteInvalidError } from '../../src/rating/votes.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { identityEpochStore } from '../../src/semantic/identity-epoch-store.ts';
import * as summaries from '../../src/semantic/summaries.ts';
import { createOwnVotesReader } from '../../src/rating/own-votes-page.ts';
import { createOwnCountedVoteReader } from '../../src/rating/own-votes-counted.ts';
import type { OwnCountedVoteRequest } from '../../src/rating/own-votes-counted.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { accessCheck } from '../../src/request/access.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { updateSubjectIdentity } from '../../src/semantic/subject.ts';
import { communityFixtureRuntime } from '../community/community-driver.ts';
import { contentGovernanceCredential } from '../content/support/system.ts';
import {
  createSourceStatisticLifecycleFixture,
  type SourceStatisticLifecycleFixture,
} from './source-statistic-lifecycle-fixture.ts';

let fixture: SourceStatisticLifecycleFixture;
beforeAll(async () => {
  fixture = await createSourceStatisticLifecycleFixture({
    nativeFigures: true,
  });
  fixture.database.pool.options.max = 1;
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

async function body(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json();
}

async function countedVoteResult(
  reader: ReturnType<typeof createOwnCountedVoteReader>,
  request: OwnCountedVoteRequest,
  deadline: number,
) {
  const prepared = await reader.prepare(request, deadline);
  if (prepared.status !== 'prepared') return prepared;
  const read = await withReadTransaction(
    fixture.database.pool,
    (client) => reader.read(client, request, prepared.preparation),
    deadline,
  );
  return reader.finish(request, prepared.preparation, read, deadline);
}

async function prepareCountedVoteRead(
  reader: ReturnType<typeof createOwnCountedVoteReader>,
  request: OwnCountedVoteRequest,
  deadline: number,
) {
  const prepared = await reader.prepare(request, deadline);
  if (prepared.status !== 'prepared') return { prepared, read: null };
  const read = await withReadTransaction(
    fixture.database.pool,
    (client) => reader.read(client, request, prepared.preparation),
    deadline,
  );
  return { prepared, read };
}

async function countedVoteActor() {
  const context = await fixture.identityCommand('rating:vote');
  if (context.actor.kind !== 'account') throw new Error('Expected an authenticated Rating voter');
  return { actor: context.actor, deadline: context.deadline };
}
const pagePath = '/v1/me/rating-votes';
const votePath = (target: string) => `/v1/subjects/${target}/ratings/${STANDARD_QUESTION_ID}/vote`;

test('public My ratings types follow the mounted closed response', () => {
  expectTypeOf<OwnVotesPage['votes'][number]>().toEqualTypeOf<OwnVoteEntry>();
  expectTypeOf<OwnVoteEntry['actions']>().toEqualTypeOf<OwnVoteActions>();
  expectTypeOf<OwnVotesPageQuery>().toEqualTypeOf<{ cursor?: string }>();
});

async function moderate(target: string, action: 'hide' | 'restore') {
  const { system, kernel } = communityFixtureRuntime();
  return body(
    await kernel.handle(
      new Request(`http://kernel.test/v1/subjects/${target}:${action}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${system.actors.moderator.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
        },
        body: JSON.stringify({ reason: 'Current Subject disclosure' }),
      }),
    ),
  );
}

test('My ratings returns the current native vote and uses its original command for change, replay and clear', async () => {
  const target = await fixture.createSubject({
    type: 'schema:Book',
    labels: { en: 'A remembered book' },
  });
  const path = votePath(target);
  await body(await fixture.request('PUT', path, { body: { units: 0 } }));
  const page = await body(await fixture.request('GET', pagePath));
  const row = page.votes.find((row: { targetId: string }) => row.targetId === target);
  expect(row).toMatchObject({
    targetId: target,
    questionId: STANDARD_QUESTION_ID,
    subject: { id: target, label: { value: 'A remembered book' } },
    question: {
      id: STANDARD_QUESTION_ID,
      scale: { min: 0, max: 20, displayStep: 1 },
    },
    own: { units: 0, revision: 1 },
    actions: { state: 'editable', put: path, clear: path, readback: path },
  });
  expect((await fixture.request('GET', row.subjectHref)).status).toBe(200);
  const key = crypto.randomUUID();
  const changed = await fixture.request('PUT', row.actions.put, {
    key,
    body: { units: 12 },
  });
  await body(changed);
  expect(changed.headers.get(SESSION_HEADER)).toBeTruthy();
  const components = decodeSession(
    { current: 1, keys: new Map([[1, new Uint8Array(32).fill(27)]]) },
    `account:${fixture.actorId}`,
    changed.headers.get(SESSION_HEADER)!,
  );
  const receipt = (
    await fixture.database.admin.query(
      'SELECT partition_no, epoch, position FROM core.receipt WHERE principal_id=$1 AND idempotency_key=$2',
      [fixture.actorId, key],
    )
  ).rows[0];
  expect(components).toContainEqual({
    partition: receipt.partition_no,
    epoch: receipt.epoch,
    position: BigInt(receipt.position),
  });
  // Discard the first response, then retry the exact original command and read back.
  const replay = await fixture.request('PUT', row.actions.put, {
    key,
    body: { units: 12 },
  });
  expect(await body(replay)).toMatchObject({ units: 12, revision: 2 });
  expect(await body(await fixture.request('GET', row.actions.readback))).toMatchObject({ units: 12, revision: 2 });
  const refreshed = await body(await fixture.request('GET', pagePath));
  expect(refreshed.votes.find((vote: { targetId: string }) => vote.targetId === target)).toMatchObject({
    subject: row.subject,
    question: row.question,
    own: { units: 12, revision: 2 },
    actions: row.actions,
  });
  const cleared = await fixture.request('DELETE', row.actions.clear);
  expect(cleared.status).toBe(204);
  expect((await fixture.request('GET', row.actions.readback)).status).toBe(404);
  const after = await body(await fixture.request('GET', pagePath));
  expect(after.votes.some((row: { targetId: string }) => row.targetId === target)).toBe(false);
  // Reading the receipt never creates a second revision or resurrects a cleared vote.
  await body(await fixture.request('PUT', path, { key, body: { units: 12 } }));
  expect((await fixture.request('GET', path)).status).toBe(404);
});

test('signed out and denied are different from an empty inventory; selection is closed', async () => {
  expect((await fixture.request('GET', pagePath, { anonymous: true })).status).toBe(401);
  expect((await fixture.request('GET', pagePath, { bearer: fixture.readerBearer })).status).toBe(403);
  expect((await fixture.request('GET', `${pagePath}?voter=${fixture.actorId}`)).status).toBe(400);
  expect((await fixture.request('GET', `${pagePath}?cursor=invalid`)).status).toBe(400);
});

test('a suppressed raw page keeps continuation; dependency failure retries the same frontier and another device resumes', async () => {
  const native = fixture.nativeFigures!;
  const viewer = native.globalVoters[0]!;
  const stranger = native.globalVoters[1]!;
  expect(await body(await native.request(pagePath, stranger))).toMatchObject({
    votes: [],
    next: null,
  });
  for (let index = 0; index < 22; index++) {
    const id = await fixture.createSubject({
      type: 'schema:Book',
      labels: { en: `Remembered ${index}` },
    });
    await native.vote(id, viewer, index % 21);
  }
  const first = await body(await native.request(pagePath, viewer));
  expect(first.votes).toHaveLength(20);
  expect(first.next).toBeString();
  const continuation = `${pagePath}?cursor=${encodeURIComponent(first.next)}`;
  expect((await native.request(continuation, stranger)).status).toBe(400);
  const { system } = communityFixtureRuntime();
  const actor = (await system.access.authenticate(viewer.bearer, {
    pool: fixture.database.pool,
    deadline: Date.now() + 30_000,
  })) as AccountActor;
  const reader = createOwnVotesReader({
    pool: fixture.database.pool,
    access: system.access,
    routeKey: system.routeKey,
    tokens: system.tokenKeys,
  });
  for (const changed of [
    { clientId: `${actor.clientId}-other` },
    { requestedBy: stranger.id },
    { scopes: [...actor.scopes, 'extra:scope'] },
  ]) {
    await expect(
      reader.page({ ...actor, ...changed }, { cursor: first.next }, Date.now() + 30_000),
    ).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
  }
  const home = partitionOf(routeOf(viewer.id)!);
  await fixture.database.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [home]);
  try {
    expect((await native.request(continuation, viewer)).status).toBe(400);
    const fresh = await body(await native.request(pagePath, viewer));
    expect(
      (await body(await native.request(`${pagePath}?cursor=${encodeURIComponent(fresh.next)}`, viewer))).votes,
    ).toHaveLength(2);
  } finally {
    await fixture.database.admin.query('UPDATE core.partition SET epoch=epoch-1 WHERE partition_no=$1', [home]);
  }
  const second = await system.auth.issue({
    accountId: viewer.id,
    clientId: system.auth.ordinaryClient.id,
    scopes: system.auth.ordinaryScopes,
  });
  const resumed = await body(
    await native.request(continuation, {
      id: viewer.id,
      bearer: second.bearer,
    }),
  );
  expect(resumed.votes).toHaveLength(2);
  expect(resumed.next).toBeNull();
  for (const row of first.votes) await moderate(row.targetId, 'hide');
  expect((await native.request(first.votes[0].actions.readback, viewer)).status).toBe(404);
  const sparse = await body(await native.request(pagePath, viewer));
  expect(sparse.votes).toEqual([]);
  expect(sparse.next).toBeString();
  expect(await body(await native.request(`${pagePath}?cursor=${encodeURIComponent(sparse.next)}`, viewer))).toEqual(
    resumed,
  );
  const unavailable = spyOn(identityEpochStore, 'readMappings').mockImplementationOnce(async () => {
    throw new AccessUnavailableError('overloaded');
  });
  try {
    expect(await body(await native.request(continuation, viewer), 503)).toMatchObject({ retryable: true });
  } finally {
    unavailable.mockRestore();
  }
  expect(await body(await native.request(continuation, viewer))).toEqual(resumed);
  await moderate(first.votes[0].targetId, 'restore');
  const restored = await body(await native.request(pagePath, viewer));
  expect(restored.votes.map((row: { targetId: string }) => row.targetId)).toEqual([first.votes[0].targetId]);
});

test('a label change after summary selection requires the same-frontier retry and returns the new label', async () => {
  const target = await fixture.createSubject({
    type: 'schema:Book',
    labels: { en: 'Current label only' },
  });
  await body(await fixture.request('PUT', votePath(target), { body: { units: 8 } }));
  const read = summaries.readSubjectSummaryObservation;
  const observation = spyOn(summaries, 'readSubjectSummaryObservation').mockImplementationOnce(async (...args) => {
    const selected = await read(...args);
    const command = await fixture.identityCommand('subject:create');
    const authorize = await accessCheck(
      fixture.access,
      command.actor,
      'subject:create',
      { route: 0, id: GLOBAL_CONTEXT },
      {
        pool: fixture.database.pool,
        deadline: Date.now() + 30_000,
      },
    );
    await updateSubjectIdentity(fixture.database.pool, {
      subject: target,
      labels: { en: 'Changed current label' },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize,
    });
    return selected;
  });
  try {
    expect(await body(await fixture.request('GET', pagePath), 503)).toMatchObject({ retryable: true });
  } finally {
    observation.mockRestore();
  }
  const retry = await body(await fixture.request('GET', pagePath));
  expect(retry.votes.find((vote: { targetId: string }) => vote.targetId === target)).toMatchObject({
    subject: { id: target, label: { value: 'Changed current label' } },
    own: { units: 8, revision: 1 },
    actions: { state: 'editable' },
  });
});

test('Realm questions keep their exact scale and retirement permits withdrawal without a new value', async () => {
  const { system, kernel } = communityFixtureRuntime();
  const staff = await contentGovernanceCredential(system);
  const call = (method: string, path: string, input?: unknown) =>
    kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${staff.bearer}`,
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
          ...(input === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }),
    );
  const question = await body(
    await call('POST', `/v1/realms/${fixture.nativeFigures!.realmId}/rating-questions`, {
      meaning: 'Enjoyment of the translation.',
      label: 'Translation',
      grain: 'release',
      scale: { min: 0, max: 10, displayStep: 2 },
    }),
    201,
  );
  const target = await fixture.createSubject();
  const path = `/v1/subjects/${target}/ratings/${question.id}/vote`;
  await body(await call('PUT', path, { units: 0 }));
  await body(
    await call('POST', `/v1/rating-questions/${question.id}/$retire`, {
      expectedLifecycleRevision: 1,
    }),
  );
  const inventory = await body(await call('GET', pagePath));
  const row = inventory.votes.find((row: { questionId: string }) => row.questionId === question.id);
  expect(row).toMatchObject({
    question: {
      label: 'Translation',
      scale: { min: 0, max: 10, displayStep: 2 },
      lifecycle: { state: 'retired' },
    },
    own: { units: 0 },
    actions: { state: 'retired', reason: 'question_retired', clear: path },
  });
  expect(row.actions.put).toBeUndefined();
  expect((await call('PUT', path, { units: 2 })).status).toBe(409);
  expect((await call('DELETE', row.actions.clear)).status).toBe(204);
});

test('fenced account homes close action advice; revoked and suspended accounts cannot load private votes', async () => {
  const target = await fixture.createSubject();
  await body(await fixture.request('PUT', votePath(target), { body: { units: 6 } }));
  const home = partitionOf(routeOf(fixture.actorId)!);
  await fixture.database.admin.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [home]);
  try {
    const page = await body(await fixture.request('GET', pagePath));
    expect(page.votes.find((vote: { targetId: string }) => vote.targetId === target).actions).toEqual({
      state: 'unavailable',
      reason: 'read_only',
    });
  } finally {
    await fixture.database.admin.query("UPDATE core.partition SET write_state='active' WHERE partition_no=$1", [home]);
  }
  for (const change of ["state='suspended'", 'minimum_authn_epoch=2']) {
    await fixture.database.admin.query(`UPDATE access.account SET ${change} WHERE account_id=$1`, [fixture.actorId]);
    try {
      expect((await fixture.request('GET', pagePath)).status).toBe(403);
    } finally {
      await fixture.database.admin.query(
        "UPDATE access.account SET state='active', minimum_authn_epoch=1 WHERE account_id=$1",
        [fixture.actorId],
      );
    }
  }
});

test('the counted reader distinguishes absent, zero, clear and unavailable and respects the raw-key bound', async () => {
  const target = await fixture.createSubject();
  const hidden = await fixture.createSubject();
  const reader = createOwnCountedVoteReader({ pool: fixture.database.pool, access: fixture.access });
  const { actor } = await countedVoteActor();
  const deadline = Date.now() + 120_000;
  const request = { actor, targetIds: [target, target] } satisfies OwnCountedVoteRequest;

  expect(await countedVoteResult(reader, request, deadline)).toMatchObject({
    status: 'current',
    observations: [{ requestedTargetId: target, state: 'absent' }],
  });
  const initialKey = crypto.randomUUID();
  expect(
    await body(await fixture.request('PUT', votePath(target), { key: initialKey, body: { units: 9 } })),
  ).toMatchObject({
    units: 9,
    revision: 1,
  });
  const zeroKey = crypto.randomUUID();
  const zero = await body(await fixture.request('PUT', votePath(target), { key: zeroKey, body: { units: 0 } }));
  expect(zero).toMatchObject({ units: 0, revision: 2 });
  expect(await body(await fixture.request('PUT', votePath(target), { key: zeroKey, body: { units: 0 } }))).toEqual(
    zero,
  );
  expect(await countedVoteResult(reader, request, deadline)).toMatchObject({
    status: 'current',
    observations: [
      {
        requestedTargetId: target,
        originalTargetId: target,
        countingTargetId: target,
        state: 'counted',
        units: 0,
        revision: 2,
        countedRevision: 2,
      },
    ],
  });

  const hundred = await countedVoteResult(reader, { actor, targetIds: Array(100).fill(target) }, deadline);
  expect(hundred).toMatchObject({
    status: 'current',
    requestedTargetIds: [target],
    observations: [{ state: 'counted' }],
  });
  await expect(reader.prepare({ actor, targetIds: Array(101).fill(target) }, deadline)).rejects.toBeInstanceOf(
    VoteInvalidError,
  );

  expect((await fixture.request('DELETE', votePath(target))).status).toBe(204);
  expect(await countedVoteResult(reader, request, deadline)).toMatchObject({
    status: 'current',
    observations: [{ state: 'clear', originalTargetId: target, units: null, revision: 3, countedRevision: 3 }],
  });
  await moderate(hidden, 'hide');
  expect(await countedVoteResult(reader, { actor, targetIds: [hidden] }, deadline)).toMatchObject({
    status: 'current',
    observations: [{ requestedTargetId: hidden, state: 'unavailable' }],
  });
}, 180_000);

test('native mapping stays preparing through merge and counted reads follow the surviving vote or clear', async () => {
  const original = await fixture.createSubject();
  const survivor = await fixture.createSubject();
  const reader = createOwnCountedVoteReader({ pool: fixture.database.pool, access: fixture.access });
  const { actor } = await countedVoteActor();
  const deadline = Date.now() + 120_000;
  const request = { actor, targetIds: [original] } satisfies OwnCountedVoteRequest;
  await body(await fixture.request('PUT', votePath(original), { body: { units: 7 } }));

  const stale = await prepareCountedVoteRead(reader, request, deadline);
  if (stale.prepared.status !== 'prepared' || stale.read === null) throw new Error('Expected a prepared source read');
  await fixture.merge(original, survivor);
  expect(await reader.finish(request, stale.prepared.preparation, stale.read, deadline)).toMatchObject({
    status: 'preparing',
    reason: 'identity-changed',
    retry: 'same-input',
  });
  expect(await reader.prepare(request, deadline)).toMatchObject({
    status: 'preparing',
    reason: 'identity-pending',
    targets: [{ requestedTargetId: original, state: 'pending' }],
  });
  await fixture.nativeFigures!.drain();
  expect(await countedVoteResult(reader, request, deadline)).toMatchObject({
    status: 'current',
    observations: [
      {
        requestedTargetId: original,
        originalTargetId: original,
        countingTargetId: survivor,
        state: 'counted',
        units: 7,
        revision: 1,
        countedRevision: 2,
      },
    ],
  });

  await body(await fixture.request('PUT', votePath(survivor), { body: { units: 0 } }));
  expect(await countedVoteResult(reader, request, deadline)).toMatchObject({
    status: 'current',
    observations: [{ originalTargetId: survivor, countingTargetId: survivor, state: 'counted', units: 0 }],
  });
  expect((await fixture.request('DELETE', votePath(survivor))).status).toBe(204);
  expect(await countedVoteResult(reader, request, deadline)).toMatchObject({
    status: 'current',
    observations: [{ originalTargetId: survivor, countingTargetId: survivor, state: 'clear', units: null }],
  });
}, 180_000);

test('equal-time merge selection and eventless losing-row cleanup leave the counted destination authoritative', async () => {
  const [candidateA, candidateB] = await Promise.all([fixture.createSubject(), fixture.createSubject()]);
  const [first, second] = [candidateA, candidateB].sort();
  const survivor = await fixture.createSubject();
  const reader = createOwnCountedVoteReader({ pool: fixture.database.pool, access: fixture.access });
  const { actor } = await countedVoteActor();
  const deadline = Date.now() + 120_000;
  await body(await fixture.request('PUT', votePath(first), { body: { units: 6 } }));
  await body(await fixture.request('PUT', votePath(second), { body: { units: 18 } }));
  await fixture.database.admin.query(
    `UPDATE rating.vote SET changed_at='2026-11-03T12:34:56.123456Z'::timestamptz
     WHERE route=$1 AND voter_id=$2 AND question_id=$3 AND target_id=ANY($4::uuid[])`,
    [routeOf(actor.accountId), actor.accountId, STANDARD_QUESTION_ID, [first, second]],
  );

  await fixture.merge(first, survivor);
  await fixture.nativeFigures!.drain();
  await fixture.merge(second, survivor);
  await fixture.nativeFigures!.drain();
  const removed = await fixture.database.admin.query(
    `DELETE FROM rating.vote
     WHERE route=$1 AND voter_id=$2 AND question_id=$3 AND target_id=$4 AND counted_target IS NULL
     RETURNING target_id`,
    [routeOf(actor.accountId), actor.accountId, STANDARD_QUESTION_ID, second],
  );
  expect(removed.rows).toHaveLength(1);
  expect(await countedVoteResult(reader, { actor, targetIds: [second] }, deadline)).toMatchObject({
    status: 'current',
    observations: [
      {
        requestedTargetId: second,
        originalTargetId: first,
        countingTargetId: survivor,
        state: 'counted',
        units: 6,
      },
    ],
  });
}, 180_000);

test('account and question observations that change after the caller read require the same-input retry', async () => {
  const target = await fixture.createSubject();
  const reader = createOwnCountedVoteReader({ pool: fixture.database.pool, access: fixture.access });
  const { actor } = await countedVoteActor();
  const deadline = Date.now() + 120_000;
  const request = { actor, targetIds: [target] } satisfies OwnCountedVoteRequest;

  const accountRows = await fixture.database.admin.query(
    'SELECT transaction_id AS "transactionId" FROM access.account WHERE account_id=$1',
    [actor.accountId],
  );
  const accountTransactionId = accountRows.rows[0]?.transactionId;
  if (typeof accountTransactionId !== 'string') throw new Error('Expected native account transaction identity');
  const accountRead = await prepareCountedVoteRead(reader, request, deadline);
  if (accountRead.prepared.status !== 'prepared' || accountRead.read === null)
    throw new Error('Expected a prepared account observation');
  const changedAccountTransactionId = crypto.randomUUID();
  await fixture.database.admin.query('UPDATE access.account SET transaction_id=$2 WHERE account_id=$1', [
    actor.accountId,
    changedAccountTransactionId,
  ]);
  try {
    expect(await reader.finish(request, accountRead.prepared.preparation, accountRead.read, deadline)).toMatchObject({
      status: 'preparing',
      reason: 'account-changed',
      retry: 'same-input',
    });
  } finally {
    await fixture.database.admin.query('UPDATE access.account SET transaction_id=$2 WHERE account_id=$1', [
      actor.accountId,
      accountTransactionId,
    ]);
  }

  const questionRows = await fixture.database.admin.query('SELECT revision FROM rating.question WHERE id=$1', [
    STANDARD_QUESTION_ID,
  ]);
  const questionRevision = questionRows.rows[0]?.revision;
  if (typeof questionRevision !== 'number') throw new Error('Expected the native standard question');
  const questionRead = await prepareCountedVoteRead(reader, request, deadline);
  if (questionRead.prepared.status !== 'prepared' || questionRead.read === null)
    throw new Error('Expected a prepared question observation');
  await fixture.database.admin.query('UPDATE rating.question SET revision=revision+1 WHERE id=$1', [
    STANDARD_QUESTION_ID,
  ]);
  try {
    expect(await reader.finish(request, questionRead.prepared.preparation, questionRead.read, deadline)).toMatchObject({
      status: 'preparing',
      reason: 'question-changed',
      retry: 'same-input',
    });
  } finally {
    await fixture.database.admin.query('UPDATE rating.question SET revision=$2 WHERE id=$1', [
      STANDARD_QUESTION_ID,
      questionRevision,
    ]);
  }
}, 180_000);
