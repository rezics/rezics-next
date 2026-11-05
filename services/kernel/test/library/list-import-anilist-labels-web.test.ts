import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { aniListLabelRequests } from '../../../../apps/web/src/library/personal-anilist-import/label-native.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { routeOf } from '../../src/route/route.ts';
import { STANDARD_QUESTION_ID, createVoteCommands } from '../../src/rating/votes.ts';
import { createSessionCommands } from '../../src/library/sessions.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture({ ownerScopes: ['rating:vote'] });
}, 120000);
afterAll(async () => {
  await f?.close();
});

function web(
  persona: 'owner' | 'other' = 'owner',
  afterEffect?: (request: Request, response: Response) => Promise<void>,
) {
  return createKernelClient('http://kernel.test', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const response = await f.handle(request);
        await afterEffect?.(request, response);
        return response;
      },
      { preconnect: fetch.preconnect },
    ),
    headers: { authorization: `Bearer ${f[persona].bearer}` },
  });
}
async function upload(rows: object[], group: object = { name: 'Existing', isCustomList: true }) {
  const response = await f.send('owner', 'POST', '/v1/libraryImports/anilist:preview', {
    upload: JSON.stringify({ lists: [{ ...group, entries: rows }] }),
    scoreFormat: 'POINT_10',
  });
  expect(response.status).toBe(200);
  return (await response.json()).id as string;
}
async function json(path: string, method = 'GET', body?: unknown, status = 200) {
  const response = await f.send('owner', method, path, body);
  expect(response.status).toBe(status);
  return response.json();
}

test('generated Web label methods reopen actual admitted rows, preserve source distinctions, native identities and independent facts across pages', async () => {
  const subjectId = await f.createSubject('game');
  const label = (await json('/v1/libraryLabels', 'POST', { name: 'Existing' }, 201)).label;
  const id = await upload(
    Array.from({ length: 23 }, () => ({
      status: 'PLANNING',
      progress: 3,
      score: 8,
      customLists: { Existing: true, New: true, Duplicate: true, False: false },
    })),
  );
  const path = '/v1/libraryImports/anilist/' + id;
  const stateReview = await json(path + ':review', 'POST', { ordinal: 0, subjectId, fields: ['status'] });
  await json(path + ':apply', 'POST', { confirmations: [{ ordinal: 0, reviewId: stateReview.review.id }] });
  // Independent native Progress and vote facts must survive every label effect and replay.
  const sessions = createSessionCommands({ pool: f.pool, access: f.access, tokens: f.tokens });
  const votes = createVoteCommands({ pool: f.pool, access: f.access });
  await votes.putVoteOutcome(
    f.owner.actor,
    { questionId: STANDARD_QUESTION_ID, targetId: subjectId, units: 7 },
    crypto.randomUUID(),
  );
  const occurrence = await sessions.startSession(
    f.owner.actor,
    { subjectId, mode: 'scalar_amount', unit: 'minute' },
    crypto.randomUUID(),
  );
  await sessions.recordProgress(f.owner.actor, occurrence.value.id, { revision: 1, amount: '3' }, crypto.randomUUID());
  const beforeEntry = await json('/v1/libraryEntries/' + subjectId);
  const beforeVote = await votes.readOwnVote(f.owner.actor, STANDARD_QUESTION_ID, subjectId);
  // The session reader pins that label import cannot manufacture a consumption occurrence.
  const beforeSessions = await sessions.listSessions(f.owner.actor, subjectId, {});
  const client = web(),
    calls = aniListLabelRequests(client, `Bearer ${f.owner.bearer}`);
  const owner = client.libraryImports.anilist!({ importId: id });
  const first = await owner.get({ query: { after: -1 } });
  expect(first.data!.rows).toHaveLength(20);
  expect(first.data!.rows[0]!.labelEvidence.values.map((item) => [item.key, item.member, item.origin])).toEqual([
    ['customLists:Existing', true, 'customLists'],
    ['customLists:New', true, 'customLists'],
    ['customLists:Duplicate', true, 'customLists'],
    ['customLists:False', false, 'customLists'],
    ['group:name', true, 'customContainer'],
  ]);
  expect((await owner.get({ query: { after: 19 } })).data!.rows).toHaveLength(3);
  const body = {
    ordinal: 0,
    subjectId,
    selections: [
      { key: 'customLists:Existing', target: { labelId: label.id as string } },
      { key: 'customLists:New', target: { name: ' E\u0301  Private ' } },
      { key: 'group:name', target: { labelId: label.id as string } },
      { key: 'customLists:Duplicate', target: { name: 'É Private' } },
    ],
  };
  expect(
    (
      await calls.review(
        id,
        { ...body, selections: [{ key: 'customLists:Existing', target: { name: 'Existing' } }] },
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(409);
  const reviewed = await calls.review(id, body, crypto.randomUUID());
  expect(reviewed.status).toBe(200);
  expect(reviewed.data!.review.items[1]!.target).toEqual({ name: 'É Private', primary: 1 });
  const confirmation = { confirmations: [{ ordinal: 0, reviewId: reviewed.data!.review.id }] };
  const applied = await calls.apply(id, confirmation);
  expect(applied.status).toBe(200);
  const items = applied.data!.outcomes[0]!.items;
  expect(items.map((item) => item.status)).toEqual(['applied', 'applied', 'unchanged', 'unchanged']);
  expect(items[0]!.assignment).toEqual(items[2]!.assignment);
  expect(items[1]!.assignment).toEqual(items[3]!.assignment);
  expect((await client.libraryLabels.get({ query: { q: 'É Private', limit: 20 } })).data!.labels[0]!.id).toBe(
    items[1]!.label!.id,
  );
  const current = await client.libraryLabelAssignments.get({ query: { subjectId, view: 'FULL', limit: 32 } });
  expect(current.data!.assignments.map((item) => item.id).sort()).toEqual(
    [items[0]!.assignment!.id, items[1]!.assignment!.id].sort(),
  );
  // Effects committed but producer work acknowledgement was lost: replay original native keys.
  await f.pool.query(
    "UPDATE library.list_import_anilist SET payload=payload-'labelWork' WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=0",
    [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, id],
  );
  expect((await calls.apply(id, confirmation)).data).toEqual(applied.data);
  expect(await json('/v1/libraryEntries/' + subjectId)).toEqual(beforeEntry);
  expect(await votes.readOwnVote(f.owner.actor, STANDARD_QUESTION_ID, subjectId)).toEqual(beforeVote);
  expect(await sessions.listSessions(f.owner.actor, subjectId, {})).toEqual(beforeSessions);
  const foreign = aniListLabelRequests(web('other'), `Bearer ${f.other.bearer}`);
  expect((await foreign.apply(id, confirmation)).status).toBe(404);
  expect((await foreign.review(id, body, crypto.randomUUID())).status).toBe(404);
  await json(path + ':cancel', 'POST', { remove: true });
}, 120000);

test('effect-before-ack creation and assignment recover exact keys; source cancellation retains facts and current labels require fresh review', async () => {
  const subjectId = await f.createSubject('unprofiled');
  const id = await upload([{ customLists: { Recovery: true } }], { name: 'Default', isCustomList: false });
  const path = '/v1/libraryImports/anilist/' + id;
  let loseApply = true;
  const client = web('owner', async (request, response) => {
    if (loseApply && request.url.endsWith(':applyLabels') && response.status === 200) {
      loseApply = false;
      throw new TypeError('fetch failed');
    }
  });
  const calls = aniListLabelRequests(client, `Bearer ${f.owner.bearer}`);
  const body = {
    ordinal: 0,
    subjectId,
    selections: [{ key: 'customLists:Recovery', target: { name: 'Web recovery' } }],
  };
  const reviewed = await calls.review(id, body, crypto.randomUUID());
  const confirmation = { confirmations: [{ ordinal: 0, reviewId: reviewed.data!.review.id }] };
  await expect(calls.apply(id, confirmation)).rejects.toThrow('fetch failed');
  const native = (await json(path)).rows[0];
  const original = native.labelWork['0'];
  expect(original.label.id).toBeTruthy();
  expect(original.outcome.assignment.id).toBeTruthy();
  // Retain a created label but lose the assignment acknowledgement. Native original assignKey recovers it.
  await f.pool.query(
    "UPDATE library.list_import_anilist SET payload=jsonb_set(payload,'{labelWork,0}', $4::jsonb) WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=0",
    [
      routeOf(f.owner.actor.accountId),
      f.owner.actor.accountId,
      id,
      JSON.stringify({ createStarted: true, assignStarted: true, label: original.label }),
    ],
  );
  const recovered = await calls.apply(id, confirmation);
  expect(recovered.data!.outcomes[0]!.items[0]!.assignment).toEqual(original.outcome.assignment);
  const label = (await json('/v1/libraryLabels?q=Web')).labels.find(
    (item: { id: string }) => item.id === original.label.id,
  );
  const fresh = await calls.review(
    id,
    { ...body, selections: [{ key: 'customLists:Recovery', target: { labelId: label.id } }] },
    crypto.randomUUID(),
  );
  await json('/v1/libraryLabels/' + label.id, 'PATCH', { name: 'Web recovery renamed', revision: label.revision });
  const stale = await calls.apply(id, { confirmations: [{ ordinal: 0, reviewId: fresh.data!.review.id }] });
  expect(stale.data!.outcomes[0]!.items[0]!.status).toBe('stale');
  const newest = await calls.review(
    id,
    { ...body, selections: [{ key: 'customLists:Recovery', target: { labelId: label.id } }] },
    crypto.randomUUID(),
  );
  expect(
    (await calls.apply(id, { confirmations: [{ ordinal: 0, reviewId: newest.data!.review.id }] })).data!.outcomes[0]!
      .items[0]!.status,
  ).toBe('unchanged');
  await json(path + ':cancel', 'POST', { remove: false });
  expect((await calls.apply(id, confirmation)).data).toEqual({ outcomes: [], complete: false });
  expect((await json('/v1/libraryLabelAssignments?subjectId=' + subjectId)).assignments).toHaveLength(1);
  await json(path + ':cancel', 'POST', { remove: true });
}, 120000);

test('a real native label created before request cancellation resumes its retained creation and assignment through Web', async () => {
  const subjectId = await f.createSubject('unprofiled');
  const id = await upload([{ customLists: { Interrupted: true } }], { name: 'Default', isCustomList: false });
  const client = web(),
    calls = aniListLabelRequests(client, `Bearer ${f.owner.bearer}`);
  const reviewed = await calls.review(
    id,
    {
      ordinal: 0,
      subjectId,
      selections: [{ key: 'customLists:Interrupted', target: { name: 'Created before cancellation' } }],
    },
    crypto.randomUUID(),
  );
  const review = reviewed.data!.review,
    item = review.items[0]!;
  const { aniListDigest } = await import('../../src/library/list-import-anilist-label-guard.ts');
  const { createPersonalLabelCommands } = await import('../../src/library/label-commands.ts');
  const { createAniListImport } = await import('../../src/library/list-import-anilist.ts');
  const { testRouteKey } = await import('../support/test-kernel.ts');
  await f.pool.query(
    "UPDATE library.list_import_anilist SET payload=jsonb_set(payload,'{labelWork}', $4::jsonb) WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=0",
    [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, id, JSON.stringify({ 0: { createStarted: true } })],
  );
  const created = await createPersonalLabelCommands({ pool: f.pool, access: f.access, tokens: f.tokens }).createLabel(
    f.owner.actor,
    { name: 'Created before cancellation' },
    item.createKey,
    {
      importId: id,
      ordinal: 0,
      reviewId: review.id,
      reviewDigest: aniListDigest(review),
      sourceDigest: review.sourceDigest,
      subjectId,
      identityEpoch: review.identityEpoch,
    },
  );
  const stop = new AbortController();
  stop.abort();
  const confirmations = [{ ordinal: 0, reviewId: review.id }];
  expect(
    await createAniListImport({
      pool: f.pool,
      access: f.access,
      tokens: f.tokens,
      routeKey: testRouteKey(),
    }).applyLabels(f.owner.actor, id, confirmations, stop.signal),
  ).toEqual({ outcomes: [], complete: false });
  expect(
    (await client.libraryLabelAssignments.get({ query: { subjectId, limit: 32, view: 'FULL' } })).data!.assignments,
  ).toHaveLength(0);
  const result = await calls.apply(id, { confirmations });
  expect(result.data!.outcomes[0]!.items[0]!.label!.id).toBe(created.value.label.id);
  expect(result.data!.outcomes[0]!.items[0]!.status).toBe('applied');
  const replay = await calls.apply(id, { confirmations });
  expect(replay.data).toEqual(result.data);
  expect(
    (await client.libraryLabelAssignments.get({ query: { subjectId, limit: 32, view: 'FULL' } })).data!.assignments[0]!
      .id,
  ).toBe(result.data!.outcomes[0]!.items[0]!.assignment!.id);
  await json('/v1/libraryImports/anilist/' + id + ':cancel', 'POST', { remove: true });
}, 120000);
