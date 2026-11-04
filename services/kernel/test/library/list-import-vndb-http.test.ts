import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { createVoteCommands, STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { parseVndb, VNDB_LIMITS } from '../../src/library/list-import-vndb-parser.ts';
import { createSessionCommands } from '../../src/library/sessions.ts';
import { OWNED_PHASES } from '../../src/library/erasure-owned-graph.ts';
import { createVndbImport, type VndbDateApplyInput } from '../../src/library/list-import-vndb.ts';
import { testRouteKey } from '../support/test-kernel.ts';
let f: NativeProfileFixture, matched: string;
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
  f = await createProfileEntryFixture();
  const producer = await f.identity(['subject:batch_write', 'subject:create', 'subject:read']);
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
test('VNDB score review preserves unsupported precision, explicit native units and clear consent without effects', async () => {
  const scorer = await f.identity([
    'subject:create',
    'subject:read',
    'library_entry:read',
    'library_entry:list',
    'library_entry:update',
    'library_entry:delete',
    'rating:vote',
  ]);
  await f.grantLibraryGate(scorer.actor.accountId);
  const source = xml(vn(vnId, '<vote>7.3</vote>'), '<reviews><review id="r1"><text>private</text></review></reviews>');
  const created = await f.send(scorer.bearer, 'POST', base + ':preview', { xml: source }, entryKey());
  expect(created.status).toBe(200);
  const { uploadId } = await created.json();
  const pageResponse = await f.send(scorer.bearer, 'GET', `${base}/${uploadId}`);
  expect(pageResponse.status).toBe(200);
  const page = await pageResponse.json();
  expect(page.rows[0].fields.score).toEqual({
    kind: 'value',
    raw: '7.3',
    value: 7.3,
    scale: { min: 1, max: 10, step: 0.1 },
  });
  expect(page.rows[0].nativeScore).toMatchObject({
    question: { id: STANDARD_QUESTION_ID, revision: 1, scale: { min: 0, max: 20, step: 1 } },
    currentVote: { state: 'absent' },
    exactUnits: null,
    admission: { status: 'unavailable', reason: 'conditional-admission-unavailable' },
  });
  expect(page.rows[0].nativeScore.sourceReason).toContain('no exact standard half-point value');
  expect(page.rows[1].nativeScore.admission.reason).toBe('source-not-vn-score');

  const missingConsent = await f.send(
    scorer.bearer,
    'POST',
    `${base}/${uploadId}:review`,
    {
      ordinal: 0,
      action: 'score',
      targetId: matched,
      questionId: STANDARD_QUESTION_ID,
      questionRevision: 1,
      selection: { kind: 'vote', units: 0 },
    },
    entryKey(),
  );
  expect(missingConsent.status).toBe(422);

  const adopted = await f.send(
    scorer.bearer,
    'POST',
    `${base}/${uploadId}:review`,
    {
      ordinal: 0,
      action: 'score',
      targetId: matched,
      questionId: STANDARD_QUESTION_ID,
      questionRevision: 1,
      selection: { kind: 'vote', units: 0 },
      consent: 'adopt-native-vote',
    },
    entryKey(),
  );
  expect(adopted.status).toBe(200);
  const adoptedReview = await adopted.json();
  expect(adoptedReview).toMatchObject({
    status: 'reviewed',
    action: 'vote',
    units: 0,
    consent: 'adopt-native-vote',
    nativeAdmission: 'unavailable',
  });

  const stateReview = await f.send(
    scorer.bearer,
    'POST',
    `${base}/${uploadId}:review`,
    { ordinal: 0, action: 'state', targetId: matched, state: 'playing', replace: false },
    entryKey(),
  );
  expect(stateReview.status).toBe(200);
  const afterStateReview = await f.send(scorer.bearer, 'GET', `${base}/${uploadId}`);
  expect((await afterStateReview.json()).rows[0].scoreDecision.reviewId).toBe(adoptedReview.reviewId);
  const cleared = await f.send(
    scorer.bearer,
    'POST',
    `${base}/${uploadId}:review`,
    {
      ordinal: 0,
      action: 'score',
      targetId: matched,
      questionId: STANDARD_QUESTION_ID,
      questionRevision: 1,
      selection: { kind: 'clear' },
      consent: 'clear-native-vote',
    },
    entryKey(),
  );
  expect(cleared.status).toBe(200);
  const clearReview = await cleared.json();
  expect(clearReview).toMatchObject({ action: 'clear', units: null, consent: 'clear-native-vote' });
  const oldConfirmation = await f.send(
    scorer.bearer,
    'POST',
    `${base}/${uploadId}:apply`,
    { rows: [{ ordinal: 0, scoreReviewId: adoptedReview.reviewId }] },
    entryKey(),
  );
  expect((await oldConfirmation.json()).outcomes[0].status).toBe('stale');
  const result = await f.send(
    scorer.bearer,
    'POST',
    `${base}/${uploadId}:apply`,
    { rows: [{ ordinal: 0, scoreReviewId: clearReview.reviewId }] },
    entryKey(),
  );
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    outcomes: [{ ordinal: 0, scoreReviewId: clearReview.reviewId, status: 'unavailable' }],
  });
  expect(
    await createVoteCommands({ pool: f.pool, access: f.access }).readOwnVote(
      scorer.actor,
      STANDARD_QUESTION_ID,
      matched,
    ),
  ).toBeNull();
}, 120000);

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
