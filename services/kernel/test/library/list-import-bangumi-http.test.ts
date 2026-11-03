import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { batchCommand } from '../../src/semantic/bulk.ts';
import { globalContextAnchor } from '../../src/semantic/context.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf } from '../../src/route/route.ts';
import { createVoteCommands, STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { testRouteKey } from '../support/test-kernel.ts';
let f: NativeProfileFixture;
let matched: string;
const root = '/v1/libraryImports/bangumi';
const providerId = 815432;
const upload = (collections: unknown[]) => ({
  upload: JSON.stringify({ format: 'rezics.bangumi-collection.v1', collections }),
});
const sample = JSON.parse(`{"subject_type":2,"type":1,"rate":0,"ep_status":0,"vol_status":2,"tags":["personal"],
  "comment":"private note sentinel","private":true,"updated_at":"2022-06-19T18:44:13.6140127+08:00",
  "started_date":"2021-03","custom":{"priority":4}}`);
const record = (subject_id = providerId) => ({ ...sample, subject_id });
const send = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) =>
  f.send('owner', method, root + path, body);
async function ok(response: Response) {
  expect(response.status).toBe(200);
  return response.json();
}
async function preview(records: unknown[]) {
  return ok(await send('POST', ':preview', upload(records)));
}
async function review(id: string, ordinal: number, target?: string) {
  return (await ok(await send('POST', `/${id}:review`, { ordinal, ...(target ? { target } : {}) }))).review;
}
const choice = (ordinal: number, r: { token: string }, state = 'preserve', skip = false) => ({
  ordinal,
  reviewToken: r.token,
  state,
  skip,
});
async function apply(id: string, rows: unknown[]) {
  return ok(await send('POST', `/${id}:apply`, { rows }));
}
async function setState(state: string) {
  const e = await f.commands.readEntry(f.owner.actor, matched);
  await f.commands.putEntry(
    f.owner.actor,
    matched,
    { state, revision: e.revision, incarnationId: e.incarnationId },
    randomUUID(),
  );
}
beforeAll(async () => {
  f = await createProfileEntryFixture();
  const importer = await f.identity(['subject:batch_write', 'subject:read']);
  await createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' }).create(
    { pool: f.pool, actor: f.steward.actor, deadline: Date.now() + 30000 },
    {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: importer.actor.accountId },
      actions: ['subject:batch_write'],
      valid: '(,)',
      key: randomUUID(),
    },
  );
  const route = tupleRoute(testRouteKey(), 'bangumi', String(providerId));
  const result = await batchCommand(f.pool, {
    actor: importer.actor,
    route,
    routeKey: testRouteKey(),
    clock: () => new Date(),
    deadline: Date.now() + 30000,
    authorization: resourceAuthorization({
      access: f.access,
      actor: importer.actor,
      action: 'subject:batch_write',
      anchor: globalContextAnchor,
      context: { pool: f.pool, deadline: Date.now() + 30000, partition: partitionOf(route) },
    }),
    release: { digest: f.originalDigest, release: f.original },
    command: {
      op: 'create',
      key: randomUUID(),
      subject: { type: 'ex:Child', labels: { en: 'Source title' } },
      source: {
        source: 'bangumi',
        external_id: String(providerId),
        record_revision: 'v0',
        digest: 'a'.repeat(64),
        converter_revision: 'fixture',
        field_group: 'facts',
      },
    },
  });
  if (!('id' in result.value)) throw new Error('Native provider subject was not created');
  matched = result.value.id;
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('own native HTTP preview, identifier match, explicit unmatched target, skip and private losses', async () => {
  const facts = async () => {
    const { receipts: _r, events: _e, partition: _p, ...facts } = await f.inspect();
    return facts;
  };
  const before = await facts();
  const rows = [record(), { ...record(999999), subject_type: 1 }, { subject_type: 999, type: 88 }, { type: 2 }];
  const { uploadId } = await preview(rows);
  const page = await ok(await send('GET', `/${uploadId}`));
  expect(page.rows[0].evidence.source).toEqual(record());
  const fields = Object.fromEntries(page.rows[0].evidence.fields.map((v: { field: string }) => [v.field, v]));
  expect(fields.rate.reason).toContain('unrated');
  expect(fields.ep_status.reason).toContain('episodes');
  expect(fields.custom.meaning).toBe('unknown');
  expect(page.rows[2].evidence.fields.some((v: { field: string }) => v.field === 'rate')).toBe(false);
  expect(await facts()).toEqual(before);
  const a = await review(uploadId, 0);
  expect(a).toMatchObject({ match: 'matched', candidates: [matched], target: matched, proposedState: 'planned' });
  expect(a.score.native.admission).toEqual({ status: 'unavailable', reason: 'native_vote_scope_required' });
  expect((await review(uploadId, 1)).match).toBe('unmatched');
  const selected = await f.createSubject('game');
  const b = await review(uploadId, 1, selected),
    c = await review(uploadId, 2),
    d = await review(uploadId, 3);
  const confirmed = [choice(0, a), choice(1, b), choice(2, c), choice(3, d, 'omit', true)];
  const result = await apply(uploadId, confirmed);
  expect(result.outcomes.map((o: { status: string }) => o.status).join(',')).toBe(
    'applied,applied,unsupported,skipped',
  );
  expect(result.outcomes[0].applied).toEqual(['type']);
  expect((await f.commands.readEntry(f.owner.actor, matched)).state).toBe('planned');
  const after = await f.inspect();
  expect(await apply(uploadId, confirmed)).toEqual(result);
  expect(await f.inspect()).toEqual(after);
  expect((await f.send('other', 'GET', `${root}/${uploadId}`)).status).toBe(404);
  expect((await f.send('other', 'POST', `${root}/${uploadId}:apply`, { rows: confirmed })).status).toBe(404);
});
test('conflict preservation, guarded replacement, stale review refresh and original command retry', async () => {
  const { uploadId } = await preview([{ ...record(), type: 2 }]);
  const initial = await review(uploadId, 0);
  expect(initial.conflict).toBe(true);
  expect((await apply(uploadId, [choice(0, initial)])).outcomes[0].status).toBe('skipped');
  const { uploadId: replace } = await preview([{ ...record(), type: 2 }]);
  const stale = await review(replace, 0);
  await setState('paused');
  expect((await apply(replace, [choice(0, stale, 'replace')])).outcomes[0].status).toBe('stale');
  const refreshed = await review(replace, 0);
  const oldRetry = { rows: [choice(0, stale, 'replace')] };
  expect((await send('POST', `/${replace}:apply`, oldRetry)).status).toBe(409);
  const confirmed = [choice(0, refreshed, 'replace')];
  const result = await apply(replace, confirmed);
  expect(result.outcomes[0].status).toBe('applied');
  expect((await f.commands.readEntry(f.owner.actor, matched)).state).toBe('completed');
  await setState('planned');
  expect(await apply(replace, confirmed)).toEqual(result);
  expect((await f.commands.readEntry(f.owner.actor, matched)).state).toBe('planned');
  const { uploadId: release } = await preview([record()]);
  const old = await review(release, 0);
  await f.activate(f.replacementDigest);
  expect((await apply(release, [choice(0, old, 'replace')])).outcomes[0].status).toBe('stale');
  await f.activate(f.originalDigest);
});
test('score review retains source scale and native vote while requiring separate consent', async () => {
  const score = await createProfileEntryFixture({ ownerScopes: ['rating:vote'] });
  try {
    const target = await score.createSubject('game');
    const votes = createVoteCommands({ pool: score.pool, access: score.access });
    await votes.putVoteOutcome(
      score.owner.actor,
      { questionId: STANDARD_QUESTION_ID, targetId: target, units: 7 },
      randomUUID(),
    );
    const rows = [
      { ...record(900001), subject_type: 4, rate: 8 },
      { ...record(900002), subject_type: 4, rate: 0 },
      Object.fromEntries(Object.entries({ ...record(900003), subject_type: 4 }).filter(([field]) => field !== 'rate')),
      { ...record(900004), subject_type: 4, rate: 10.5 },
    ];
    const created = await score.send('owner', 'POST', `${root}:preview`, upload(rows));
    const { uploadId } = await ok(created);
    const reviews = [];
    for (let ordinal = 0; ordinal < rows.length; ordinal++) {
      const response = await score.send('owner', 'POST', `/${uploadId}:review`, {
        ordinal,
        target,
        score:
          ordinal === 0 || ordinal === 3
            ? { action: 'set', units: 13 }
            : ordinal === 1
              ? { action: 'clear' }
              : { action: 'preserve' },
      });
      reviews.push((await ok(response)).review);
    }
    expect(reviews.map((review) => review.score.source.state)).toEqual([
      'score',
      'unrated',
      'absent',
      'unsupported',
    ]);
    expect(reviews[0].score).toMatchObject({
      source: { state: 'score', value: 8, scale: { minimum: 1, maximum: 10 } },
      native: {
        questionId: STANDARD_QUESTION_ID,
        question: { id: STANDARD_QUESTION_ID, revision: 1, scale: { minimum: 0, maximum: 20, step: 1 } },
        currentVote: { state: 'set', units: 7 },
        selection: { action: 'set', units: 13 },
        admission: { status: 'unavailable', reason: 'conditional_admission_unavailable' },
      },
    });
    expect(typeof reviews[0].score.native.question.meaning).toBe('string');
    expect(reviews[3].score.source.reason).toContain('integer');

    const missingConsent = await score.send('owner', 'POST', `/${uploadId}:apply`, {
      rows: [{ ordinal: 0, reviewToken: reviews[0].token, state: 'preserve', skip: false, score: { action: 'set', units: 13 } }],
    });
    expect(missingConsent.status).toBe(400);
    const preserved = await score.send('owner', 'POST', `/${uploadId}:apply`, {
      rows: [{ ordinal: 2, reviewToken: reviews[2].token, state: 'preserve', skip: false }],
    });
    expect((await ok(preserved)).outcomes[0].score).toMatchObject({ action: 'preserve', status: 'skipped' });
    const changedChoice = await score.send('owner', 'POST', `/${uploadId}:apply`, {
      rows: [
        {
          ordinal: 0,
          reviewToken: reviews[0].token,
          state: 'preserve',
          skip: false,
          score: { action: 'set', units: 12, consent: true },
        },
      ],
    });
    expect(changedChoice.status).toBe(409);
    const applied = await score.send('owner', 'POST', `/${uploadId}:apply`, {
      rows: [
        {
          ordinal: 0,
          reviewToken: reviews[0].token,
          state: 'preserve',
          skip: false,
          score: { action: 'set', units: 13, consent: true },
        },
      ],
    });
    expect((await ok(applied)).outcomes[0].score).toMatchObject({
      action: 'set',
      status: 'unavailable',
      reason: 'conditional_admission_unavailable',
    });
    const clear = await score.send('owner', 'POST', `/${uploadId}:apply`, {
      rows: [
        {
          ordinal: 1,
          reviewToken: reviews[1].token,
          state: 'preserve',
          skip: false,
          score: { action: 'clear', consent: true },
        },
      ],
    });
    expect((await ok(clear)).outcomes[0].score).toMatchObject({
      action: 'clear',
      status: 'unavailable',
      reason: 'conditional_admission_unavailable',
    });
    expect(await votes.readOwnVote(score.owner.actor, STANDARD_QUESTION_ID, target)).toMatchObject({ units: 7 });
  } finally {
    await score.close();
  }
});
test('bounds, invalid values, cancellation, deletion and terminal authority denial', async () => {
  for (const body of [
    { upload: '{' },
    upload([]),
    upload(Array(101).fill({})),
    { upload: 'x'.repeat(262145) },
    upload([{ comment: 'x'.repeat(8193) }]),
    upload([{ api_token: 'private note sentinel' }]),
  ]) {
    const response = await send('POST', ':preview', body);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('private note sentinel');
  }
  const { uploadId } = await preview([{ type: 123, subject_type: 999, rate: -1, ep_status: null }, record()]);
  const view = await ok(await send('GET', `/${uploadId}`));
  expect(view.rows[0].evidence.fields.map((v: { meaning: string }) => v.meaning).join(',')).toBe(
    'unknown,unknown,invalid,invalid',
  );
  const r = await review(uploadId, 1);
  expect((await send('POST', `/${uploadId}:apply`, { rows: Array(6).fill(choice(1, r)) })).status).toBe(400);
  await ok(await send('POST', `/${uploadId}:cancel`));
  expect((await send('POST', `/${uploadId}:apply`, { rows: [choice(1, r)] })).status).toBe(409);
  await ok(await send('DELETE', `/${uploadId}`));
  expect((await send('GET', `/${uploadId}`)).status).toBe(404);
  const terminal = await preview([record()]);
  const t = await review(terminal.uploadId, 0);
  await f.revokeIdentity(f.owner.actor.accountId);
  for (const [method, path, body] of [
    ['GET', `/${terminal.uploadId}`, undefined],
    ['POST', `/${terminal.uploadId}:apply`, { rows: [choice(0, t, 'replace')] }],
    ['POST', ':preview', upload([record()])],
  ] as const) {
    expect([401, 403]).toContain((await send(method, path, body)).status);
  }
});
