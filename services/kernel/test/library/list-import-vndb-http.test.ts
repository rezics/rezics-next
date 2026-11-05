import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { seedShowcasePersonalList } from '../../../importer/src/showcase-personal-list.ts';
import { ShowcaseJournal } from '../../../importer/src/showcase-publication.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { createVoteCommands, STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { createLibraryCommandRunner } from '../../src/library/command-support.ts';
import { parseVndb, VNDB_LIMITS } from '../../src/library/list-import-vndb-parser.ts';
import { createSessionCommands } from '../../src/library/sessions.ts';
import { OWNED_PHASES } from '../../src/library/erasure-owned-graph.ts';
import { createVndbImport, type VndbDateApplyInput } from '../../src/library/list-import-vndb.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import { subjectTarget } from '../../src/semantic/subject.ts';
import { partitionOf } from '../../src/route/route.ts';
import { installIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap-install.ts';
import { stepIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap.ts';
let f: NativeProfileFixture, matched: string, producerBearer: string;
const vnId = `v${Date.now()}${Math.floor(Math.random() * 100000)}`;
const base = '/v1/libraryImports/vndb';
const xml = (rows: string, extra = '') =>
  `<vndb-export version="1.0" uid="u1"><vns>${rows}</vns>${extra}</vndb-export>`;
const vn = (id: string, fields = '') => `<vn id="${id}"><title>Display only</title>${fields}</vn>`;
async function json(method: string, path: string, body?: unknown, persona = 'owner', key = entryKey()) {
  const response = await f.send(persona, method, path, body, key);
  expect(response.status).toBe(200);
  return response.json();
}
const upload = (source: string) => json('POST', base + ':preview', { xml: source });
const review = (id: string, body: unknown) => json('POST', `${base}/${id}:review`, body);
const apply = (id: string, rows: { ordinal: number; reviewId: string }[]) =>
  json('POST', `${base}/${id}:apply`, { rows });
beforeAll(async () => {
  f = await createProfileEntryFixture({ gameUnits: ['minute', 'episode'] });
  const producer = await f.identity(['subject:batch_write', 'subject:create', 'subject:read']);
  producerBearer = producer.bearer;
  await createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' }).create(
    { pool: f.pool, actor: f.steward.actor, deadline: deadlineFor(30000) },
    {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: producer.actor.accountId },
      actions: ['subject:batch_write'],
      valid: '(,)',
      key: entryKey(),
    },
  );
  const created = await json(
    'POST',
    '/v1/subjects:batchWrite',
    {
      commands: [
        {
          op: 'create',
          key: entryKey(),
          source: {
            source: 'vndb',
            external_id: vnId,
            record_revision: '1',
            digest: 'a'.repeat(64),
            converter_revision: 'vndb@1',
            field_group: 'facts',
          },
          subject: { type: 'ex:Child', labels: { en: 'Display only' } },
        },
      ],
    },
    producer.bearer,
  );
  expect(created.results[0]).toMatchObject({ status: 201 });
  matched = created.results[0].value.id;
}, 120000);
afterAll(() => f?.close());
test('own HTTP upload, admitted VN identifier, explicit unmatched resolution and bounded confirmed outcomes retain private losses', async () => {
  const target = await f.createSubject('game');
  const before = await f.inspect();
  const source = xml(
    vn(
      vnId,
      '<label label="Playing" private="1"/><vote>8.5</vote><started>2020-05-00</started><finished>2021-02-03</finished><notes>private note</notes><progress unit="minute">0</progress><unknown>keep</unknown>',
    ) +
      vn('v999999999999') +
      vn('v999999999998'),
    '<reviews><review id="1"><text>not a public review</text></review></reviews><releases><release id="r42"><vn id="v42"/></release></releases>',
  );
  const made = await upload(source),
    id = made.uploadId;
  const page = await json('GET', `${base}/${id}`);
  expect(page.rows[0].match).toEqual({ status: 'matched', candidates: [matched] });
  expect(page.rows[1].match.status).toBe('unmatched');
  expect(page.rows[0].fields).toMatchObject({
    score: { value: 8.5, scale: { min: 1, max: 10, step: 0.1 } },
    started: { value: '2020-05', precision: 'month' },
    finished: { precision: 'day' },
    notes: { value: 'private note' },
    progress: { value: '0' },
    progressMeasure: { value: 'minute' },
  });
  expect(page.rows[4].identifier).toBeNull();
  expect((await f.inspect()).entries).toEqual(before.entries);
  expect((await f.send('other', 'GET', `${base}/${id}`)).status).toBe(404);
  expect((await f.send('other', 'GET', `${base}/${id}/source`)).status).toBe(404);
  const a = await review(id, { ordinal: 0, action: 'state', state: 'playing' });
  const b = await review(id, { ordinal: 1, action: 'state', state: 'planned', targetId: target });
  const c = await review(id, { ordinal: 2, action: 'skip' });
  const d = await review(id, { ordinal: 3, action: 'retain' });
  const selection = [a, b, c, d].map((r, ordinal) => ({ ordinal, reviewId: r.reviewId }));
  const result = await apply(id, selection);
  expect(result.outcomes.map((r: { status: string }) => r.status)).toEqual([
    'applied',
    'applied',
    'skipped',
    'unsupported',
  ]);
  const effects = await f.inspect();
  expect((await apply(id, selection)).outcomes).toEqual(result.outcomes);
  expect(await f.inspect()).toEqual(effects);
  expect((await f.commands.readEntry(f.owner.actor, matched)).state).toBe('playing');
  expect((await f.commands.readEntry(f.owner.actor, target)).state).toBe('planned');
  expect(effects.sessions).toEqual(before.sessions);
  expect(effects.copies).toEqual(before.copies);
  expect(effects.entitlements).toEqual(before.entitlements);
  expect(await json('GET', `${base}/${id}/source`)).toEqual({ xml: source });
  expect((await f.send('other', 'POST', `${base}/${id}:apply`, { rows: selection })).status).toBe(404);
  await json('DELETE', `${base}/${id}`);
}, 120000);
test('VNDB Progress requires its declared current-profile unit, uses exported play-time minutes, applies selected zero and preserves occurrence state and other measures', async () => {
  const sessions = createSessionCommands({ pool: f.pool, access: f.access, tokens: f.tokens });
  const started = await sessions.startSession(
    f.owner.actor,
    {
      subjectId: matched,
      versionSubjectId: null,
      mode: 'scalar_amount',
      unit: 'minute',
      total: null,
      additionalMeasures: [{ unit: 'episode', total: null }],
    },
    entryKey(),
  );
  const minute = await sessions.recordProgress(
    f.owner.actor,
    started.value.id,
    { revision: started.value.revision, measureId: 'minute', amount: '2' },
    entryKey(),
  );
  const episode = await sessions.recordProgress(
    f.owner.actor,
    started.value.id,
    { revision: minute.value.revision, measureId: 'episode', amount: '6' },
    entryKey(),
  );

  const id = (
    await upload(
      xml(vn(vnId, '<label label="Playing"/>'), `<length-votes>${vn(vnId, '<minutes>0</minutes>')}</length-votes>`),
    )
  ).uploadId;
  const state = await review(id, { ordinal: 0, action: 'state', targetId: matched, state: 'completed', replace: true });
  const reviewed = await review(id, {
    ordinal: 1,
    action: 'progress',
    targetId: matched,
    progress: {
      occurrence: { kind: 'existing', sessionId: started.value.id },
      measures: [{ field: 'minutes', action: 'adopt', replace: true }],
    },
  });
  expect(reviewed.progress).toMatchObject({
    complete: false,
    measures: [{ field: 'minutes', unit: 'minute', status: 'unattempted', sourceAmount: '0', currentAmount: '2' }],
  });
  const applied = await apply(id, [
    { ordinal: 0, reviewId: state.reviewId },
    { ordinal: 1, reviewId: reviewed.reviewId },
  ]);
  expect(applied.outcomes[1]).toMatchObject({
    status: 'applied',
    progress: {
      complete: true,
      measures: [{ field: 'minutes', unit: 'minute', status: 'applied', sourceAmount: '0' }],
      readback: {
        sessionId: started.value.id,
        state: 'active',
        unit: 'minute',
        amount: '0',
        measures: [{ unit: 'episode', amount: '6' }],
      },
    },
  });
  expect((await f.commands.readEntry(f.owner.actor, matched)).state).toBe('completed');
  const current = await json('GET', `/v1/progressSessions/${started.value.id}`);
  expect(current.progressSession).toMatchObject({
    id: started.value.id,
    state: 'active',
    unit: 'minute',
    amount: '0',
    revision: episode.value.revision + 1,
    measures: [{ unit: 'episode', amount: '6' }],
  });
  expect(applied.outcomes[1].progress.readback.revision).toBe(current.progressSession.revision);

  const unsupportedId = (await upload(xml(vn(vnId, '<progress unit="minute">4</progress>')))).uploadId;
  const unsupportedReview = await review(unsupportedId, {
    ordinal: 0,
    action: 'progress',
    targetId: matched,
    progress: {
      occurrence: { kind: 'existing', sessionId: started.value.id },
      measures: [{ field: 'progress', action: 'adopt' }],
    },
  });
  expect(unsupportedReview.progress.measures[0]).toMatchObject({ status: 'unsupported', unit: null });
  const unsupported = await apply(unsupportedId, [{ ordinal: 0, reviewId: unsupportedReview.reviewId }]);
  expect(unsupported.outcomes[0].progress.measures[0].status).toBe('unsupported');
  expect((await json('GET', `/v1/progressSessions/${started.value.id}`)).progressSession).toMatchObject({
    revision: current.progressSession.revision,
    amount: '0',
    measures: [{ unit: 'episode', amount: '6' }],
  });
  const retained = await json('GET', `${base}/${unsupportedId}`);
  expect(retained.rows[0].fields.progress).toMatchObject({ kind: 'value', raw: '4', value: '4' });
  const missingId = (await upload(xml('', `<length-votes>${vn(vnId)}</length-votes>`))).uploadId;
  const missing = await review(missingId, {
    ordinal: 0,
    action: 'progress',
    targetId: matched,
    progress: {
      occurrence: { kind: 'existing', sessionId: started.value.id },
      measures: [{ field: 'minutes', action: 'adopt' }],
    },
  });
  expect(missing.progress.measures[0]).toMatchObject({ status: 'missing', currentAmount: '0' });
  const cleared = await review(missingId, {
    ordinal: 0,
    action: 'progress',
    targetId: matched,
    progress: {
      occurrence: { kind: 'existing', sessionId: started.value.id },
      measures: [{ field: 'minutes', action: 'clear' }],
    },
  });
  expect(
    (await apply(missingId, [{ ordinal: 0, reviewId: cleared.reviewId }])).outcomes[0].progress.readback,
  ).toMatchObject({
    amount: null,
    measures: [{ unit: 'episode', amount: '6' }],
  });
  await json('DELETE', `${base}/${missingId}`);
  const startId = (await upload(xml('', `<length-votes>${vn(vnId, '<minutes>12</minutes>')}</length-votes>`))).uploadId;
  const entryBefore = await f.commands.readEntry(f.owner.actor, matched);
  const selectedStart = await review(startId, {
    ordinal: 0,
    action: 'progress',
    targetId: matched,
    progress: {
      occurrence: { kind: 'start', primaryUnit: 'minute' },
      measures: [{ field: 'minutes', action: 'adopt' }],
    },
  });
  const startedImport = await apply(startId, [{ ordinal: 0, reviewId: selectedStart.reviewId }]);
  expect(startedImport.outcomes[0].progress.readback).toMatchObject({ unit: 'minute', amount: '12' });
  expect(startedImport.outcomes[0].progress.readback.sessionId).not.toBe(started.value.id);
  expect(await f.commands.readEntry(f.owner.actor, matched)).toEqual(entryBefore);
  await json('DELETE', `${base}/${startId}`);
  await json('DELETE', `${base}/${id}`);
  await json('DELETE', `${base}/${unsupportedId}`);
}, 120000);
test('a changed export updates the same matched Library entry and current readback without creating another entry', async () => {
  const before = await f.inspect();
  const firstUpload = await upload(
    xml(vn(vnId, '<label label="Playing"/><vote>8.5</vote><progress unit="chapter">4</progress>')),
  );
  const firstPage = await json('GET', `${base}/${firstUpload.uploadId}`);
  expect(firstPage.rows[0].match).toEqual({ status: 'matched', candidates: [matched] });
  expect(firstPage.rows[0].fields).toMatchObject({
    score: { value: 8.5 },
    progress: { value: '4' },
    progressMeasure: { value: 'chapter' },
  });
  const firstReview = await review(firstUpload.uploadId, { ordinal: 0, action: 'state', state: 'playing' });
  const firstApplied = await apply(firstUpload.uploadId, [{ ordinal: 0, reviewId: firstReview.reviewId }]);
  expect(firstApplied.outcomes[0].status).toBe('applied');
  const firstEntry = await f.commands.readEntry(f.owner.actor, matched);
  expect(firstEntry.state).toBe('playing');
  const afterFirst = await f.inspect();
  expect(afterFirst.entries).toHaveLength(before.entries.length + 1);

  const changedUpload = await upload(
    xml(vn(vnId, '<label label="Finished"/><vote>9.2</vote><progress unit="chapter">12</progress>')),
  );
  const changedPage = await json('GET', `${base}/${changedUpload.uploadId}`);
  expect(changedPage.rows[0].match).toEqual({ status: 'matched', candidates: [matched] });
  expect(changedPage.rows[0].fields).toMatchObject({
    score: { value: 9.2 },
    progress: { value: '12' },
    progressMeasure: { value: 'chapter' },
  });
  const changedReview = await review(changedUpload.uploadId, {
    ordinal: 0,
    action: 'state',
    state: 'completed',
    replace: true,
  });
  const changedApplied = await apply(changedUpload.uploadId, [{ ordinal: 0, reviewId: changedReview.reviewId }]);
  expect(changedApplied.outcomes[0].status).toBe('applied');
  const current = await f.commands.readEntry(f.owner.actor, matched);
  expect(current).toMatchObject({ state: 'completed', incarnationId: firstEntry.incarnationId });
  expect(current.revision).toBeGreaterThan(firstEntry.revision);
  const afterChanged = await f.inspect();
  expect(afterChanged.entries).toHaveLength(afterFirst.entries.length);
  expect(afterChanged.sessions).toEqual(before.sessions);
  await json('DELETE', `${base}/${firstUpload.uploadId}`);
  await json('DELETE', `${base}/${changedUpload.uploadId}`);
}, 120000);
test('reviewed conflicts preserve facts, revision and release guards reject stale choices, cancellation stops remaining rows', async () => {
  const target = await f.createSubject('game');
  await f.commands.putEntry(f.owner.actor, target, { state: 'planned' }, entryKey());
  const { uploadId: id } = await upload(xml(vn('v999999999997') + vn('v999999999996')));
  const choice = { ordinal: 0, action: 'state', state: 'playing', targetId: target };
  const kept = await review(id, choice);
  expect((await apply(id, [{ ordinal: 0, reviewId: kept.reviewId }])).outcomes[0].status).toBe('skipped');
  const replaced = await review(id, { ...choice, replace: true });
  const local = await f.commands.readEntry(f.owner.actor, target);
  await f.commands.putEntry(
    f.owner.actor,
    target,
    { state: 'playing', revision: local.revision, incarnationId: local.incarnationId },
    entryKey(),
  );
  expect((await apply(id, [{ ordinal: 0, reviewId: replaced.reviewId }])).outcomes[0].status).toBe('stale');
  const refreshed = await review(id, { ...choice, state: 'planned', replace: true });
  const original = [{ ordinal: 0, reviewId: refreshed.reviewId }];
  // Native receipt replay retains the original command operands.
  const started = await apply(id, original);
  expect(started.outcomes[0].status).toBe('applied');
  const stored = await f.pool.query('SELECT decisions FROM library.vndb_import WHERE account_id=$1 AND upload_id=$2', [
    f.owner.actor.accountId,
    id,
  ]);
  const decision = stored.rows[0].decisions['0'];
  const receipt = await f.commands.putEntry(
    f.owner.actor,
    target,
    { state: decision.state, revision: decision.baseline.revision, incarnationId: decision.baseline.incarnationId },
    decision.commandKey,
    decision.guard,
  );
  expect(receipt.replayed).toBe(true);
  const pending = await review(id, {
    ordinal: 1,
    action: 'state',
    state: 'planned',
    targetId: await f.createSubject('game'),
  });
  await json('POST', `${base}/${id}:cancel`);
  expect(await apply(id, [{ ordinal: 1, reviewId: pending.reviewId }])).toMatchObject({
    outcomes: [],
    stopped: 'cancelled',
  });
  await json('DELETE', `${base}/${id}`);
  const next = await upload(xml(vn('v999999999995')));
  const stale = await review(next.uploadId, {
    ordinal: 0,
    action: 'state',
    state: 'playing',
    targetId: target,
    replace: true,
  });
  await f.activate(f.replacementDigest);
  expect((await apply(next.uploadId, [{ ordinal: 0, reviewId: stale.reviewId }])).outcomes[0].status).toBe('stale');
  await json('DELETE', `${base}/${next.uploadId}`);
  await f.activate(f.originalDigest);
}, 120000);
async function sameHomeScoreCaller() {
  const scorer = await f.identity(
    [
      'subject:create',
      'subject:read',
      'library_entry:read',
      'library_entry:list',
      'library_entry:update',
      'library_entry:delete',
      'rating:vote',
    ],
    0,
  );
  await f.grantLibraryGate(scorer.actor.accountId);
  let key = entryKey();
  while (partitionOf(subjectTarget(testRouteKey(), scorer.actor.accountId, key).route) !== 0) key = entryKey();
  const created = await f.send(
    scorer.bearer,
    'POST',
    '/v1/subjects',
    {
      type: 'ex:Child',
      labels: { en: 'Explicit score target' },
    },
    key,
  );
  expect(created.status).toBe(201);
  const target = (await created.json()).subject.id as string;
  await installIdentityEpochBootstrap(f.pool);
  let state;
  do {
    state = (await stepIdentityEpochBootstrap(f.pool, 0)).state;
  } while (state !== 'caught-up');
  const send = (method: string, path: string, body?: unknown) => json(method, path, body, scorer.bearer);
  const votes = createVoteCommands({ pool: f.pool, access: f.access, createCommandRunner: createLibraryCommandRunner });
  const service = createVndbImport({ pool: f.pool, access: f.access, tokens: f.tokens, routeKey: testRouteKey() });
  const scoreReview = (id: string, units: number | null) =>
    send('POST', `${base}/${id}:review`, {
      ordinal: 0,
      action: 'score',
      targetId: target,
      questionId: STANDARD_QUESTION_ID,
      questionRevision: 1,
      selection: units === null ? { kind: 'clear' } : { kind: 'vote', units },
      consent: units === null ? 'clear-native-vote' : 'adopt-native-vote',
    });
  const stored = async (id: string) =>
    (
      await f.pool.query(
        "SELECT decisions->'0'->'score' AS score FROM library.vndb_import WHERE account_id=$1 AND upload_id=$2",
        [scorer.actor.accountId, id],
      )
    ).rows[0].score;
  async function importUpload(source: string) {
    const journal = new ShowcaseJournal(':memory:');
    const client = createKernelClient('http://kernel.test', {
      headers: { authorization: `Bearer ${scorer.bearer}` },
      fetch: ((input, init) => f.handle(new Request(input, init))) as typeof fetch,
    });
    try {
      const input = {
        client,
        journal,
        xml: source,
        identity: { origin: 'http://kernel.test', actor: scorer.actor, credential: { keyId: 'native-score-caller' } },
      };
      const result = await seedShowcasePersonalList(input);
      expect(result.state).toBe('uploaded');
      expect(await seedShowcasePersonalList(input)).toEqual(result);
      if (result.state !== 'uploaded') throw new Error(result.code);
      return result;
    } finally {
      journal.close();
    }
  }
  return { ...scorer, target, send, votes, service, scoreReview, stored, importUpload };
}

test('VNDB explicit unmatched score choice commits chosen units, zero and clear with counted current readback and independent Entry state', async () => {
  const c = await sameHomeScoreCaller();
  const source = xml(
    vn('v999999999991', '<vote>7.3</vote>'),
    '<reviews><review id="r1"><text>private</text></review></reviews>',
  );
  const { uploadId, rows } = await c.importUpload(source);
  expect(rows).toBe(2);
  const page = await c.send('GET', `${base}/${uploadId}`);
  expect(page.rows[0].match.status).toBe('unmatched');
  expect(page.rows[0].fields.score).toEqual({
    kind: 'value',
    raw: '7.3',
    value: 7.3,
    scale: { min: 1, max: 10, step: 0.1 },
  });
  expect(page.rows[0].nativeScore).toMatchObject({
    question: { id: STANDARD_QUESTION_ID, revision: 1, scale: { min: 0, max: 20, step: 1 } },
    exactUnits: null,
    admission: { status: 'conditional', reason: null },
  });
  expect(page.rows[0].nativeScore.sourceReason).toContain('no exact standard half-point value');
  expect(page.rows[1].nativeScore.admission.reason).toBe('source-not-vn-score');
  const missingConsent = await f.send(
    c.bearer,
    'POST',
    `${base}/${uploadId}:review`,
    {
      ordinal: 0,
      action: 'score',
      targetId: c.target,
      questionId: STANDARD_QUESTION_ID,
      questionRevision: 1,
      selection: { kind: 'vote', units: 0 },
    },
    entryKey(),
  );
  expect(missingConsent.status).toBe(422);
  const retired = await c.scoreReview(uploadId, 0);
  const chosen = await c.scoreReview(uploadId, 15);
  expect(chosen).toMatchObject({
    status: 'reviewed',
    units: 15,
    consent: 'adopt-native-vote',
    nativeAdmission: 'conditional',
  });
  const state = await c.send('POST', `${base}/${uploadId}:review`, {
    ordinal: 0,
    action: 'state',
    targetId: c.target,
    state: 'playing',
    replace: false,
  });
  expect((await c.send('GET', `${base}/${uploadId}`)).rows[0].scoreDecision.reviewId).toBe(chosen.reviewId);
  expect(
    (
      await c.send('POST', `${base}/${uploadId}:apply`, {
        rows: [{ ordinal: 0, scoreReviewId: retired.reviewId }],
      })
    ).outcomes[0].status,
  ).toBe('stale');
  const reviewed = await c.stored(uploadId);
  expect(reviewed.nativeGuard).toMatchObject({
    ownVote: { state: 'absent' },
    subject: { identity: { version: 1, requestedOriginalId: c.target, sourceHomes: [0] } },
  });
  const applied = await c.send('POST', `${base}/${uploadId}:apply`, {
    rows: [{ ordinal: 0, reviewId: state.reviewId, scoreReviewId: chosen.reviewId }],
  });
  expect(applied.outcomes).toMatchObject([
    { status: 'applied' },
    { status: 'applied', currentVote: { state: 'set', units: 15 } },
  ]);
  const entry = await f.commands.readEntry(c.actor, c.target);
  const inventory = await f.inspect(c.actor.accountId);
  expect(entry.state).toBe('playing');
  expect((await c.votes.readVoteReview(c.actor, STANDARD_QUESTION_ID, c.target)).currentVote).toMatchObject({
    state: 'counted',
    units: 15,
  });
  const frozen = await c.stored(uploadId);
  expect(frozen).toMatchObject({ status: 'applied', nativeGuard: reviewed.nativeGuard, commandActor: c.actor });
  expect(frozen.sourceDigest).toHaveLength(64);
  expect(frozen.matchDigest).toHaveLength(64);
  expect(JSON.stringify(await c.send('GET', `${base}/${uploadId}`))).not.toContain('nativeGuard');

  for (const units of [0, null]) {
    const next = await c.send('POST', base + ':preview', {
      xml: xml(vn('v999999999991', units === null ? '' : '<vote>8.2</vote>')),
    });
    if (units === null) {
      expect((await c.send('GET', `${base}/${next.uploadId}`)).rows[0].fields.score.kind).toBe('missing');
      expect((await c.votes.readVoteReview(c.actor, STANDARD_QUESTION_ID, c.target)).currentVote).toMatchObject({
        state: 'counted',
        units: 0,
      });
    }
    const choice = await c.scoreReview(next.uploadId, units);
    const selection = { rows: [{ ordinal: 0, scoreReviewId: choice.reviewId }] };
    const expected = units === null ? { state: 'cleared' } : { state: 'set', units: 0 };
    expect((await c.send('POST', `${base}/${next.uploadId}:apply`, selection)).outcomes[0]).toMatchObject({
      status: 'applied',
      currentVote: expected,
    });
    const current = (await c.votes.readVoteReview(c.actor, STANDARD_QUESTION_ID, c.target)).currentVote;
    expect(current).toMatchObject(units === null ? { state: 'clear', units: null } : { state: 'counted', units: 0 });
    expect((await c.send('POST', `${base}/${next.uploadId}:apply`, selection)).outcomes[0].currentVote).toMatchObject(
      expected,
    );
    expect(await f.commands.readEntry(c.actor, c.target)).toEqual(entry);
    expect((await f.inspect(c.actor.accountId)).sessions).toEqual(inventory.sessions);
    await c.send('DELETE', `${base}/${next.uploadId}`);
  }
  // Applied confirmations report the current counted value, not the old receipt's value.
  expect(
    (
      await c.send('POST', `${base}/${uploadId}:apply`, {
        rows: [{ ordinal: 0, scoreReviewId: chosen.reviewId }],
      })
    ).outcomes[0].currentVote,
  ).toMatchObject({ state: 'cleared' });
  await c.send('DELETE', `${base}/${uploadId}`);
}, 180000);

test('lost score acknowledgements reconcile the original credential and exact native effect after cancellation or expiry', async () => {
  const c = await sameHomeScoreCaller();
  for (const [index, terminal] of ['cancel', 'expire'].entries()) {
    const { uploadId } = await c.send('POST', base + ':preview', {
      xml: xml(vn('v999999999992', '<vote>7.3</vote>') + vn('v999999999993', '<vote>8</vote>')),
    });
    const chosen = await c.scoreReview(uploadId, 15 + index);
    let acknowledgements = 0;
    await expect(
      c.service.apply(c.actor, uploadId, [{ ordinal: 0, scoreReviewId: chosen.reviewId }], () => {
        if (++acknowledgements === 2) throw new Error('Lost score acknowledgement');
      }),
    ).rejects.toThrow('Lost score acknowledgement');
    const frozen = await c.stored(uploadId);
    expect(frozen).toMatchObject({ status: 'applying', commandActor: c.actor });
    expect(frozen.command.input).toMatchObject({ units: 15 + index, guard: frozen.nativeGuard });
    expect(frozen.command.receipt.requestKey).toBe(frozen.commandKey);
    const committed = await c.votes.reconcilePutVote(c.actor, frozen.command.receipt);
    expect(committed?.vote).toMatchObject({ units: 15 + index });
    expect(committed?.component).not.toBeNull();
    // Current authority is required even when the exact receipt already exists.
    await f.pool.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE account_id=$1', [c.actor.accountId]);
    try {
      await expect(
        c.service.apply(c.actor, uploadId, [{ ordinal: 0, scoreReviewId: chosen.reviewId }], () => {}),
      ).rejects.toMatchObject({ name: 'GrantDeniedError' });
    } finally {
      await f.pool.query('UPDATE access.account SET minimum_authn_epoch=1 WHERE account_id=$1', [c.actor.accountId]);
    }
    // A receipt is historical evidence; readback must use the current counted reader.
    await c.votes.putVoteOutcome(
      c.actor,
      { questionId: STANDARD_QUESTION_ID, targetId: c.target, units: 18 },
      entryKey(),
    );
    const snapshot = async () =>
      (
        await f.pool.query(
          `SELECT
      (SELECT jsonb_agg(to_jsonb(v)) FROM rating.vote v WHERE voter_id=$1) AS votes,
      (SELECT count(*)::int FROM core.receipt WHERE principal_id=$1 AND command_kind='rating.vote.put') AS receipts`,
          [c.actor.accountId],
        )
      ).rows[0];
    const effects = await snapshot();
    if (terminal === 'cancel') await c.send('POST', `${base}/${uploadId}:cancel`);
    else {
      await f.pool.query(
        "UPDATE library.vndb_import SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND upload_id=$2",
        [c.actor.accountId, uploadId],
      );
      for (const suffix of ['', '/source'])
        expect((await f.send(c.bearer, 'GET', `${base}/${uploadId}${suffix}`)).status).toBe(404);
    }
    expect(
      await c.service.apply(
        c.actor,
        uploadId,
        [
          { ordinal: 0, scoreReviewId: chosen.reviewId },
          { ordinal: 1, scoreReviewId: entryKey() },
        ],
        () => {},
      ),
    ).toMatchObject({
      outcomes: [{ status: 'applied', currentVote: { state: 'set', units: 18 } }],
      stopped: 'cancelled',
    });
    expect(await snapshot()).toEqual(effects);
    expect(await c.stored(uploadId)).toEqual({ ...frozen, status: 'applied' });
    expect(await c.votes.reconcilePutVote(c.actor, frozen.command.receipt)).toEqual(committed);
    await c.send('DELETE', `${base}/${uploadId}`);
    expect((await f.send(c.bearer, 'GET', `${base}/${uploadId}/source`)).status).toBe(404);
    expect(await snapshot()).toEqual(effects);
  }
}, 180000);

test('an original score intent cannot admit a fresh effect after source change, cancellation, expiry or removal', async () => {
  const c = await sameHomeScoreCaller();
  for (const change of [
    'source',
    'review',
    'match',
    'own-vote',
    'question',
    'meaning',
    'scale',
    'identity',
    'cancel',
    'expire',
    'remove',
  ]) {
    const externalId = `v${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const { uploadId } = await c.send('POST', base + ':preview', { xml: xml(vn(externalId, '<vote>7.3</vote>')) });
    const chosen = await c.scoreReview(uploadId, 14);
    await expect(
      c.service.apply(c.actor, uploadId, [{ ordinal: 0, scoreReviewId: chosen.reviewId }], () => {
        throw new Error('Interrupted before score dispatch');
      }),
    ).rejects.toThrow('Interrupted before score dispatch');
    const frozen = await c.stored(uploadId);
    expect(frozen).toMatchObject({ status: 'applying', commandActor: c.actor });
    expect(await c.votes.reconcilePutVote(c.actor, frozen.command.receipt)).toBeNull();
    if (change === 'source')
      await f.pool.query(
        "UPDATE library.vndb_import SET rows=jsonb_set(rows,'{0,fields,score,raw}','\"8.1\"') WHERE account_id=$1 AND upload_id=$2",
        [c.actor.accountId, uploadId],
      );
    if (change === 'review')
      await f.pool.query(
        "UPDATE library.vndb_import SET decisions=jsonb_set(decisions,'{0,score,sourceDigest}',to_jsonb(repeat('f',64))) WHERE account_id=$1 AND upload_id=$2",
        [c.actor.accountId, uploadId],
      );
    if (change === 'match') {
      const result = await json(
        'POST',
        '/v1/subjects:batchWrite',
        {
          commands: [
            {
              op: 'create',
              key: entryKey(),
              source: {
                source: 'vndb',
                external_id: externalId,
                record_revision: '1',
                digest: 'a'.repeat(64),
                converter_revision: 'vndb@1',
                field_group: 'facts',
              },
              subject: { type: 'ex:Child', labels: { en: 'New provider match' } },
            },
          ],
        },
        producerBearer,
      );
      expect(result.results[0].status).toBe(201);
    }
    const originalMeaning =
      change === 'meaning'
        ? (await f.pool.query('SELECT meaning FROM rating.question WHERE id=$1', [STANDARD_QUESTION_ID])).rows[0]
            .meaning
        : null;
    if (change === 'meaning')
      await f.pool.query("UPDATE rating.question SET meaning=meaning || ' changed' WHERE id=$1", [
        STANDARD_QUESTION_ID,
      ]);
    if (change === 'own-vote')
      await c.votes.putVoteOutcome(
        c.actor,
        { questionId: STANDARD_QUESTION_ID, targetId: c.target, units: 3 },
        entryKey(),
      );
    if (change === 'question')
      await f.pool.query('UPDATE rating.question SET revision=revision+1 WHERE id=$1', [STANDARD_QUESTION_ID]);
    if (change === 'scale')
      await f.pool.query('UPDATE rating.question SET maximum_units=maximum_units+1 WHERE id=$1', [
        STANDARD_QUESTION_ID,
      ]);
    if (change === 'identity')
      await f.pool.query(
        'UPDATE semantic.identity_epoch_control SET allocated_epoch=allocated_epoch+1, published_epoch=published_epoch+1 WHERE partition_no=0',
      );
    if (change === 'cancel') await c.send('POST', `${base}/${uploadId}:cancel`);
    if (change === 'expire')
      await f.pool.query(
        "UPDATE library.vndb_import SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND upload_id=$2",
        [c.actor.accountId, uploadId],
      );
    if (change === 'remove') await c.send('DELETE', `${base}/${uploadId}`);
    const before = await c.votes.readOwnVote(c.actor, STANDARD_QUESTION_ID, c.target);
    try {
      const pending = c.service.apply(c.actor, uploadId, [{ ordinal: 0, scoreReviewId: chosen.reviewId }], () => {});
      if (change === 'remove') await expect(pending).rejects.toMatchObject({ name: 'LibraryNotFoundError' });
      else expect((await pending).outcomes[0]?.status).toBe('stale');
      expect(await c.votes.readOwnVote(c.actor, STANDARD_QUESTION_ID, c.target)).toEqual(before);
      expect(await c.votes.reconcilePutVote(c.actor, frozen.command.receipt)).toBeNull();
      if (change !== 'remove') expect((await c.stored(uploadId)).command).toEqual(frozen.command);
    } finally {
      if (change === 'question')
        await f.pool.query('UPDATE rating.question SET revision=revision-1 WHERE id=$1', [STANDARD_QUESTION_ID]);
      if (change === 'meaning')
        await f.pool.query('UPDATE rating.question SET meaning=$2 WHERE id=$1', [
          STANDARD_QUESTION_ID,
          originalMeaning,
        ]);
      if (change === 'scale')
        await f.pool.query('UPDATE rating.question SET maximum_units=maximum_units-1 WHERE id=$1', [
          STANDARD_QUESTION_ID,
        ]);
      if (change === 'identity')
        await f.pool.query(
          'UPDATE semantic.identity_epoch_control SET allocated_epoch=allocated_epoch-1, published_epoch=published_epoch-1 WHERE partition_no=0',
        );
      if (change !== 'remove') await c.send('DELETE', `${base}/${uploadId}`);
    }
  }
}, 180000);

test('VNDB typed dates select one repeat, preserve precision, and clear only with explicit consent', async () => {
  const sessions = createSessionCommands({ pool: f.pool, access: f.access, tokens: f.tokens }),
    first = (
      await sessions.startSession(
        f.owner.actor,
        { subjectId: matched, mode: 'scalar_amount', unit: 'minute' },
        entryKey(),
      )
    ).value,
    second = (
      await sessions.startSession(
        f.owner.actor,
        { subjectId: matched, mode: 'scalar_amount', unit: 'minute' },
        entryKey(),
      )
    ).value,
    { uploadId } = await upload(xml(vn(vnId, '<started>2020-05-00</started><finished>2021-02-03</finished>'))),
    providerReview = await review(uploadId, { ordinal: 0, action: 'retain' });
  expect(
    (
      await f.send('other', 'POST', `${base}/${uploadId}/dates/review`, {
        ordinal: 0,
        sourceReviewToken: providerReview.reviewId,
        occurrenceId: first.id,
        startAction: 'adopt',
      })
    ).status,
  ).toBe(404);
  const reviewed = await json('POST', `${base}/${uploadId}/dates/review`, {
    ordinal: 0,
    sourceReviewToken: providerReview.reviewId,
    occurrenceId: first.id,
    startAction: 'adopt',
    finishAction: 'adopt',
  });
  expect(reviewed.fields).toMatchObject({
    startDate: { proposed: { year: 2020, month: 5 }, precision: 'month', status: 'ready' },
    finishDate: { proposed: { year: 2021, month: 2, day: 3 }, status: 'ready' },
  });
  const applied = await json('POST', `${base}/${uploadId}/dates/apply`, {
    confirm: true,
    rows: [{ ordinal: 0, version: reviewed.version, fields: ['startDate', 'finishDate'] }],
  });
  expect(applied.outcomes[0].fields.map((field: { status: string }) => field.status)).toEqual(['applied', 'applied']);
  expect(await sessions.readSessionJournal(f.owner.actor, first.id)).toMatchObject({
    startDate: { year: 2020, month: 5 },
    finishDate: { year: 2021, month: 2, day: 3 },
  });
  expect((await json('GET', `${base}/${uploadId}`)).rows[0].consumptionDateOutcome.fields).toMatchObject([
    { field: 'startDate', status: 'applied' },
    { field: 'finishDate', status: 'applied' },
  ]);
  expect(await sessions.readSessionJournal(f.owner.actor, second.id)).toMatchObject({
    startDate: null,
    finishDate: null,
  });
  await sessions.patchSessionJournal(
    f.owner.actor,
    second.id,
    { revision: 1, startDate: { year: 1999 }, finishDate: { year: 2000 } },
    entryKey(),
  );
  const clear = await json('POST', `${base}/${uploadId}/dates/review`, {
    ordinal: 0,
    sourceReviewToken: providerReview.reviewId,
    occurrenceId: second.id,
    startAction: 'clear',
    finishAction: 'clear',
  });
  const cleared = await json('POST', `${base}/${uploadId}/dates/apply`, {
    confirm: true,
    rows: [{ ordinal: 0, version: clear.version, fields: ['startDate', 'finishDate'] }],
  });
  expect(cleared.outcomes[0].fields.map((field: { status: string }) => field.status)).toEqual(['cleared', 'cleared']);
  expect(await sessions.readSessionJournal(f.owner.actor, second.id)).toMatchObject({
    startDate: null,
    finishDate: null,
  });
  expect((await sessions.readSession(f.owner.actor, first.id)).revision).toBe(1);
  expect((await sessions.readSession(f.owner.actor, second.id)).revision).toBe(1);
  const pending = await json('POST', `${base}/${uploadId}/dates/review`, {
    ordinal: 0,
    sourceReviewToken: providerReview.reviewId,
    occurrenceId: first.id,
    startAction: 'clear',
  });
  const service = createVndbImport({ pool: f.pool, access: f.access, tokens: f.tokens, routeKey: testRouteKey() });
  const selection: VndbDateApplyInput = {
    confirm: true,
    rows: [{ ordinal: 0, version: pending.version, fields: ['startDate'] }],
  };
  let acknowledgements = 0;
  expect(
    await service.applyConsumptionDates(f.owner.actor, uploadId, selection, () => {
      if (++acknowledgements === 2) throw new Error('Lost journal acknowledgement');
    }),
  ).toMatchObject({ outcomes: [{ status: 'failed' }] });
  const accepted = await sessions.readSessionJournal(f.owner.actor, first.id);
  await f.pool.query(
    "UPDATE library.vndb_import SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND upload_id=$2",
    [f.owner.actor.accountId, uploadId],
  );
  expect(await json('POST', `${base}/${uploadId}/dates/apply`, selection)).toMatchObject({
    outcomes: [{ fields: [{ status: 'cleared' }] }],
  });
  expect(await sessions.readSessionJournal(f.owner.actor, first.id)).toEqual(accepted);
  await json('DELETE', `${base}/${uploadId}`);
}, 120000);
test('lost state acknowledgement reconciles the original receipt after expiry without source disclosure or a second effect', async () => {
  const service = createVndbImport({ pool: f.pool, access: f.access, tokens: f.tokens, routeKey: testRouteKey() });
  const target = await f.createSubject('game'),
    untouched = await f.createSubject('game');
  const source = xml(
    vn('v1234', '<vote> 07.3 </vote><notes>  exact\ntext  </notes><started> 2020-05-00 </started>') + vn('v1235'),
  );
  const { uploadId: id } = await upload(source);
  const page = await json('GET', `${base}/${id}`);
  expect(page.rows[0].fields).toMatchObject({
    score: { raw: ' 07.3 ', value: 7.3 },
    notes: { raw: '  exact\ntext  ', value: '  exact\ntext  ' },
    started: { raw: ' 2020-05-00 ', value: '2020-05', precision: 'month' },
  });
  expect(await json('GET', `${base}/${id}/source`)).toEqual({ xml: source });
  const first = await review(id, { ordinal: 0, action: 'state', targetId: target, state: 'planned' });
  const second = await review(id, { ordinal: 1, action: 'state', targetId: untouched, state: 'playing' });
  let acknowledgements = 0;
  expect(
    (
      await service.apply(f.owner.actor, id, [{ ordinal: 0, reviewId: first.reviewId }], () => {
        if (++acknowledgements === 2) throw new Error('Lost native acknowledgement');
      })
    ).outcomes[0]?.status,
  ).toBe('failed');
  const accepted = await f.commands.readEntry(f.owner.actor, target),
    effects = await f.inspect();
  await f.pool.query(
    "UPDATE library.vndb_import SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND upload_id=$2",
    [f.owner.actor.accountId, id],
  );
  for (const suffix of ['', '/source'])
    expect((await f.send('owner', 'GET', `${base}/${id}${suffix}`)).status).toBe(404);
  expect(
    await apply(id, [
      { ordinal: 0, reviewId: first.reviewId },
      { ordinal: 1, reviewId: second.reviewId },
    ]),
  ).toMatchObject({ outcomes: [{ ordinal: 0, status: 'applied' }], stopped: 'cancelled' });
  expect(await f.commands.readEntry(f.owner.actor, target)).toEqual(accepted);
  expect(await f.inspect()).toEqual(effects);
  const stored = await f.pool.query(
    "SELECT decisions->'0'->'receipt' AS receipt FROM library.vndb_import WHERE account_id=$1 AND upload_id=$2",
    [f.owner.actor.accountId, id],
  );
  expect(stored.rows[0].receipt.transactionId).toBe(accepted.transactionId);
  await json('DELETE', `${base}/${id}`);
}, 120000);

test('an interrupted state dispatch cannot create a fact after source cancellation', async () => {
  const service = createVndbImport({ pool: f.pool, access: f.access, tokens: f.tokens, routeKey: testRouteKey() });
  const target = await f.createSubject('game'),
    { uploadId: id } = await upload(xml(vn('v1236')));
  const reviewed = await review(id, { ordinal: 0, action: 'state', targetId: target, state: 'planned' });
  await expect(
    service.apply(f.owner.actor, id, [{ ordinal: 0, reviewId: reviewed.reviewId }], () => {
      throw new Error('Interrupted before dispatch');
    }),
  ).rejects.toThrow('Interrupted before dispatch');
  const effects = await f.inspect();
  await json('POST', `${base}/${id}:cancel`);
  expect(await apply(id, [{ ordinal: 0, reviewId: reviewed.reviewId }])).toMatchObject({
    outcomes: [{ status: 'stale' }],
    stopped: 'cancelled',
  });
  expect(await f.inspect()).toEqual(effects);
  await json('DELETE', `${base}/${id}`);
}, 120000);

test('correcting one match retires only that rows consent; metadata lost acknowledgement replays after expiry', async () => {
  const service = createVndbImport({ pool: f.pool, access: f.access, tokens: f.tokens, routeKey: testRouteKey() });
  const first = await f.createSubject('game'),
    second = await f.createSubject('game'),
    corrected = await f.createSubject('game');
  const { uploadId: id } = await upload(
    xml(vn(vnId, '<notes>One</notes><label label="Custom"/>') + vn('v1238', '<notes>Two</notes>')),
  );
  const reviews = [];
  for (const [ordinal, targetId] of [first, second].entries()) {
    const decision = await review(id, { ordinal, action: 'retain', targetId });
    reviews.push(await json('POST', `${base}/${id}:reviewMetadata`, { ordinal, sourceReviewToken: decision.reviewId }));
  }
  const correction = await review(id, { ordinal: 0, action: 'retain', targetId: corrected });
  expect((await f.send('owner', 'GET', `${base}/${id}/metadata/0?reviewToken=${reviews[0].reviewToken}`)).status).toBe(
    409,
  );
  expect(
    await json('POST', `${base}/${id}:applyMetadata`, {
      ordinal: 0,
      reviewToken: reviews[0].reviewToken,
      fields: [{ field: 'note', action: 'adopt' }],
    }),
  ).toMatchObject({ fields: [{ status: 'stale' }] });
  const labels = await json('POST', `${base}/${id}/labels:review`, {
    rows: [{ ordinal: 0, reviewId: correction.reviewId }],
    mappings: [{ source: 'Custom', target: { name: entryKey() } }],
  });
  expect(await json('POST', `${base}/${id}/labels:apply`, { previewId: labels.previewId, items: [0] })).toMatchObject({
    outcomes: [{ status: 'applied', subjectId: corrected }],
  });
  const selection = [{ field: 'note', action: 'adopt' }];
  expect(
    await service.applyMetadata(f.owner.actor, id, 1, reviews[1].reviewToken, selection, () => {
      throw new Error('Lost annotation acknowledgement');
    }),
  ).toMatchObject({ fields: [{ status: 'failed' }] });
  await f.pool.query(
    "UPDATE library.vndb_import SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND upload_id=$2",
    [f.owner.actor.accountId, id],
  );
  const effects = await f.inspect();
  expect(
    await json('POST', `${base}/${id}:applyMetadata`, {
      ordinal: 1,
      reviewToken: reviews[1].reviewToken,
      fields: selection,
    }),
  ).toMatchObject({ fields: [{ status: 'applied' }] });
  expect(await f.inspect()).toEqual(effects);
  expect((await json('GET', `/v1/libraryEntries/${corrected}/personal`)).personalEntry.note).toBeNull();
  expect((await json('GET', `/v1/libraryEntries/${second}/personal`)).personalEntry.note).toBe('Two');
  await json('DELETE', `${base}/${id}`);
}, 120000);

test('XML bounds, exact identifier kinds, missing/zero/invalid evidence and native terminal denial', async () => {
  const zero = parseVndb(xml(vn('v1', '<vote>0</vote><started>bad</started><finished>0000-00-00</finished>')))[0]!;
  for (const name of ['score', 'started']) expect(zero.fields[name]?.kind).toBe('invalid');
  expect(zero.fields.finished?.kind).toBe('unknown');
  expect(zero.fields.notes?.kind).toBe('missing');
  for (const bad of [
    '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>' + xml(vn('v1')),
    xml(vn('r1')),
    xml('<a>'.repeat(33) + '</a>'.repeat(33)),
    xml(vn('v1')).slice(0, -2),
    'x'.repeat(VNDB_LIMITS.bytes + 1),
    xml(vn('v1').repeat(VNDB_LIMITS.rows)),
  ]) {
    expect((await f.send('owner', 'POST', base + ':preview', { xml: bad })).status).toBe(400);
  }
  expect(
    (await f.send('owner', 'POST', base + ':preview', { xml: 'x'.repeat(VNDB_LIMITS.wireBytes + 1) })).status,
  ).toBe(413);
  const made = await upload(xml(vn('v1')));
  expect(OWNED_PHASES).toContain('vndb_import');
  await f.revokeIdentity(f.owner.actor.accountId);
  for (const [method, path, body] of [
    ['GET', `${base}/${made.uploadId}`, undefined],
    ['POST', `${base}/${made.uploadId}:apply`, { rows: [{ ordinal: 0, reviewId: entryKey() }] }],
    [
      'POST',
      `${base}/${made.uploadId}/dates/apply`,
      { confirm: true, rows: [{ ordinal: 0, version: entryKey(), fields: ['startDate'] }] },
    ],
  ] as const)
    expect([401, 403]).toContain((await f.send('owner', method, path, body)).status);
}, 120000);
