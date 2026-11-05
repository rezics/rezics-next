import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseAniList, AniListInputError } from '../../src/library/list-import-anilist-parser.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { authenticateAccount } from '../support/admitted-access.ts';
import { createVoteCommands, STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { createLibraryCommandRunner } from '../../src/library/command-support.ts';
import { createSessionCommands } from '../../src/library/sessions.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});
const base = '/v1/libraryImports/anilist';
const row = {
  mediaId: 1,
  media: { id: 1, type: 'ANIME', title: { romaji: 'Private watch list' } },
  status: 'PLANNING',
  score: 0,
  progress: 0,
  progressVolumes: 2,
  repeat: 3,
  private: true,
  notes: 'private note',
  startedAt: { year: 2023, month: null, day: null },
  completedAt: { year: 2024, month: 2, day: 29 },
  updatedAt: 1700000000,
  customLists: { Favourites: true },
  advancedScores: { Story: 8 },
  unfamiliar: { keep: true },
};
test('the supported GraphQL wrappers preserve distinct zero, missing, fuzzy, invalid and unknown source evidence', () => {
  const collection = {
    hasNextChunk: true,
    lists: [{ name: 'Private custom', isCustomList: true, entries: [row] }],
  };
  const document = { data: { MediaListCollection: collection } };
  const parsed = parseAniList(JSON.stringify(document), 'POINT_10');
  expect(parsed.document).toEqual(document);
  expect(parsed.rows[0]!.evidence).toEqual(row);
  expect(parsed.rows[0]!.group).toEqual({ name: 'Private custom', isCustomList: true });
  expect(parsed.rows[0]!.identifiers).toEqual([{ source: 'anilist', externalId: '1' }]);
  expect(parsed.rows[0]!.fields.find((f) => f.field === 'score')!.validity).toBe('valid');
  const invalid = parseAniList(
    JSON.stringify([{ status: 'FUTURE', score: 80, progress: -1, completedAt: { year: 2023, month: 2, day: 29 } }]),
  );
  expect(invalid.rows[0]!.fields.map((f) => f.validity)).toEqual(['invalid', 'unknown', 'invalid', 'invalid']);
  const precise = parseAniList('[{"score":1.0000000000000001}]', 'POINT_100');
  expect(precise.rows[0]!.scoreLexeme).toBe('1.0000000000000001');
  expect(precise.rows[0]!.fields[0]).toMatchObject({
    validity: 'invalid',
    reason: expect.stringContaining('POINT_100'),
  });
  expect(parseAniList('[{"score":0.31}]', 'POINT_10_DECIMAL').rows[0]!.fields[0]!.validity).toBe('invalid');
  const point3 = parseAniList('[{"score":2}]', 'POINT_3');
  expect(point3.rows[0]!.fields[0]).toMatchObject({ validity: 'valid', reason: expect.stringContaining('POINT_3') });
  const absentAndNull = parseAniList('[{"score":null},{},{"score":0}]', 'POINT_10');
  expect(
    absentAndNull.rows.map((item) => item.fields.find((field) => field.field === 'score')?.validity ?? 'absent'),
  ).toEqual(['unknown', 'absent', 'valid']);
  expect(parseAniList(JSON.stringify([{ id: 9 }])).rows[0]!.identifiers).toEqual([]);
  for (const upload of [
    '{',
    '{}',
    JSON.stringify(Array(201).fill(row)),
    ' '.repeat(1048577),
    JSON.stringify([{ notes: 'x'.repeat(65536) }]),
    JSON.stringify([{ notes: '\0' }]),
  ])
    expect(() => parseAniList(upload)).toThrow(AniListInputError);
});
test('mounted own upload, admitted identifier match, explicit resolution, conflict, original-command retry and fences', async () => {
  const importer = await f.identity([
    'subject:batch_write',
    'subject:create',
    'subject:read',
    'library_entry:update',
    'library_entry:read',
    'rating:vote',
    'progress_session:create',
    'progress_session:read',
    'progress_session:update',
  ]);
  await f.grantLibraryGate(importer.actor.accountId);
  const steward = await authenticateAccount(
    f.access,
    { pool: f.pool, deadline: deadlineFor(30000) },
    { ...f.steward.actor, scopes: ['access:grant', 'subject:batch_write'] },
  );
  await createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' }).create(
    { pool: f.pool, actor: steward, deadline: deadlineFor(30000) },
    {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: importer.actor.accountId },
      actions: ['subject:batch_write'],
      valid: '(,)',
      key: entryKey(),
    },
  );
  const mediaId = Math.floor(Math.random() * 1_000_000_000) + 1;
  const subjects: string[] = [];
  for (const source of ['anilist', 'myanimelist']) {
    const made = await f.send(importer.bearer, 'POST', '/v1/subjects:batchWrite', {
      commands: [
        {
          op: 'create',
          key: entryKey(),
          source: {
            source,
            external_id: String(mediaId),
            record_revision: '1',
            digest: (source === 'anilist' ? 'a' : 'b').repeat(64),
            converter_revision: 'fixture@1',
            field_group: 'facts',
          },
          subject: { type: 'ex:Child', labels: { en: 'Admitted subject' } },
        },
      ],
    });
    expect(made.status).toBe(200);
    const result = (await made.json()).results[0];
    expect(result).toMatchObject({ status: 201 });
    subjects.push(result.value.id);
  }
  const subjectId = subjects[0]!;
  const votes = createVoteCommands({ pool: f.pool, access: f.access, createCommandRunner: createLibraryCommandRunner });
  await votes.putVoteOutcome(
    importer.actor,
    { questionId: STANDARD_QUESTION_ID, targetId: subjectId, units: 11 },
    entryKey(),
  );
  const upload = JSON.stringify([
    { ...row, mediaId, media: { ...row.media, id: mediaId } },
    { ...row, mediaId: mediaId + 1, media: {} },
    { notes: 'retained only' },
  ]);
  const preview = await f.send(importer.bearer, 'POST', base + ':preview', { upload, scoreFormat: 'POINT_10' });
  expect(preview.status).toBe(200);
  const { id } = await preview.json();
  const path = base + '/' + id;
  const page = await f.send(importer.bearer, 'GET', path);
  expect(page.status).toBe(200);
  const body = await page.json();
  expect(body.header.rawUpload).toBe(upload);
  expect(body.rows[0].match).toMatchObject({ state: 'matched', candidates: [subjectId] });
  expect(body.rows[0].source.evidence.notes).toBe('private note');
  expect(body.rows[1].match.state).toBe('unmatched');
  expect((await f.send(importer.bearer, 'GET', `/v1/libraryEntries/${subjectId}`)).status).toBe(404);
  expect((await f.send('other', 'GET', path)).status).toBe(404);
  expect((await f.send('other', 'POST', path + ':review', { ordinal: 0, fields: ['status'] })).status).toBe(404);
  expect((await f.send('anonymous', 'GET', path)).status).toBeGreaterThanOrEqual(401);
  async function review(ordinal: number, input: Record<string, unknown>, target = path) {
    const response = await f.send(importer.bearer, 'POST', target + ':review', {
      ordinal,
      fields: ['status', 'score'],
      ...input,
    });
    expect(response.status).toBe(200);
    return { ordinal, reviewId: (await response.json()).review.id };
  }
  let first = await review(0, {});
  const skipped = await review(2, { skip: true });
  const sessions = createSessionCommands({ pool: f.pool, access: f.access, tokens: f.tokens }),
    repeats = await Promise.all(
      [0, 1].map(() =>
        sessions.startSession(importer.actor, { subjectId, mode: 'scalar_amount', unit: 'minute' }, entryKey()),
      ),
    );
  async function reviewDates(occurrenceId: string, sourceReviewToken = first.reviewId) {
    const response = await f.send(importer.bearer, 'POST', `${path}/dates/review`, {
      ordinal: 0,
      sourceReviewToken,
      occurrenceId,
      startAction: 'adopt',
      finishAction: 'adopt',
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  async function applyDates(dateReview: { version: string }) {
    const response = await f.send(importer.bearer, 'POST', `${path}/dates/apply`, {
      confirm: true,
      rows: [{ ordinal: 0, version: dateReview.version, fields: ['startDate', 'finishDate'] }],
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  const firstDateReview = await reviewDates(repeats[0]!.value.id);
  expect(firstDateReview.fields).toMatchObject({
    startDate: { proposed: { year: 2023 }, precision: 'year', status: 'ready' },
    finishDate: { proposed: { year: 2024, month: 2, day: 29 }, status: 'ready' },
  });
  const refreshedSourceReview = await review(0, {});
  expect((await applyDates(firstDateReview)).outcomes[0].status).toBe('stale');
  first = refreshedSourceReview;
  await sessions.patchSessionJournal(
    importer.actor,
    repeats[0]!.value.id,
    { revision: 1, startDate: { year: 2022 } },
    entryKey(),
  );
  expect((await applyDates(firstDateReview)).outcomes[0].status).toBe('stale');
  const correctedReview = await reviewDates(repeats[0]!.value.id),
    corrected = await applyDates(correctedReview);
  expect(corrected.outcomes[0].fields.map((field: { status: string }) => field.status)).toEqual(['applied', 'applied']);
  expect(await sessions.readSessionJournal(importer.actor, repeats[0]!.value.id)).toMatchObject({
    startDate: { year: 2023 },
    finishDate: { year: 2024, month: 2, day: 29 },
  });
  const reopenedDates = await (await f.send(importer.bearer, 'GET', path)).json();
  expect(reopenedDates.rows[0].consumptionDateOutcome.fields.map((field: { status: string }) => field.status)).toEqual([
    'applied',
    'applied',
  ]);
  const secondDateReview = await reviewDates(repeats[1]!.value.id);
  expect((await applyDates(secondDateReview)).outcomes[0].status).toBe('applied');
  expect(await sessions.readSessionJournal(importer.actor, repeats[1]!.value.id)).toMatchObject({
    startDate: { year: 2023 },
    finishDate: { year: 2024, month: 2, day: 29 },
  });
  expect((await sessions.readSession(importer.actor, repeats[0]!.value.id)).revision).toBe(1);
  const apply = async (confirmations: unknown[], target = path) => {
    const response = await f.send(importer.bearer, 'POST', target + ':apply', { confirmations });
    expect(response.status).toBe(200);
    return response.json();
  };
  const applied = await apply([first, skipped]);
  expect(applied.outcomes.map((r: { status: string }) => r.status)).toEqual(['applied', 'skipped']);
  expect(applied.outcomes[0].retained).toContain('score');
  expect(await apply([first])).toEqual({ outcomes: [applied.outcomes[0]], complete: true });
  expect(await votes.readOwnVote(importer.actor, STANDARD_QUESTION_ID, subjectId)).toMatchObject({ units: 11 });
  const entry = await (await f.send(importer.bearer, 'GET', `/v1/libraryEntries/${subjectId}`)).json();
  expect(entry.libraryEntry.state).toBe('planned');
  expect(entry.libraryEntry.revision).toBe(1);
  const conflict = await review(1, { subjectId });
  expect((await apply([conflict])).outcomes[0].status).toBe('skipped');
  const resolved = await f.send(importer.bearer, 'POST', base + ':preview', {
    upload: JSON.stringify([{ status: 'COMPLETED' }, { score: 9 }]),
    scoreFormat: 'POINT_10',
  });
  const path2 = base + '/' + (await resolved.json()).id;
  const chosen = await review(0, { subjectId, fields: ['status'], replace: true }, path2);
  expect((await apply([chosen], path2)).outcomes[0].status).toBe('applied');
  const unsupported = await review(1, { subjectId, fields: ['score'] }, path2);
  expect((await apply([unsupported], path2)).outcomes[0].status).toBe('unsupported');
  const scoreChoiceResponse = await f.send(importer.bearer, 'POST', path2 + ':review', {
    ordinal: 1,
    subjectId,
    fields: [],
    replace: true,
    score: { action: 'vote', questionId: STANDARD_QUESTION_ID, questionRevision: 1, units: 0 },
  });
  expect(scoreChoiceResponse.status).toBe(200);
  const scoreChoice = (await scoreChoiceResponse.json()).review;
  expect(scoreChoice.score).toMatchObject({
    source: { value: 9, lexeme: '9', scale: 'POINT_10', validity: 'valid' },
    action: 'vote',
    units: 0,
    conversion: 'owner-selected-native-units',
    native: {
      availability: 'available',
      guard: {
        version: 1,
        question: { revision: 1, lifecycleRevision: 1 },
        subject: { canonicalId: subjectId },
        ownVote: { state: 'present' },
      },
      question: { id: STANDARD_QUESTION_ID, revision: 1, minimumUnits: 0, maximumUnits: 20, stepUnits: 1 },
      currentVote: { status: 'current', vote: { units: 11 } },
      consented: false,
    },
  });
  const scoreConfirmation = { ordinal: 1, reviewId: scoreChoice.id };
  const omittedConsent = await apply([scoreConfirmation], path2);
  expect(omittedConsent).toMatchObject({ complete: false, outcomes: [{ score: { status: 'skipped' } }] });
  expect(await votes.readOwnVote(importer.actor, STANDARD_QUESTION_ID, subjectId)).toMatchObject({ units: 11 });
  await votes.putVoteOutcome(
    importer.actor,
    { questionId: STANDARD_QUESTION_ID, targetId: subjectId, units: 13 },
    crypto.randomUUID(),
  );
  const consented = await f.send(importer.bearer, 'POST', path2 + ':apply', {
    confirmations: [{ ...scoreConfirmation, confirmNativeVoteEffects: true }],
  });
  expect(consented.status).toBe(200);
  expect(await consented.json()).toMatchObject({
    complete: true,
    outcomes: [{ status: 'stale', score: { status: 'stale', reason: 'own_vote_changed' } }],
  });
  expect(await votes.readOwnVote(importer.actor, STANDARD_QUESTION_ID, subjectId)).toMatchObject({ units: 13 });
  const scorePage = await f.send(importer.bearer, 'GET', path2);
  expect(scorePage.status).toBe(200);
  const scoreRow = (await scorePage.json()).rows[1];
  expect(scoreRow.currentScore.vote).toMatchObject({ units: 13 });
  expect(scoreRow.review.score.native.guard).toEqual(scoreChoice.score.native.guard);
  const exactRetry = await f.send(importer.bearer, 'POST', path2 + ':apply', {
    confirmations: [{ ...scoreConfirmation, confirmNativeVoteEffects: true }],
  });
  expect(exactRetry.status).toBe(200);
  expect(await exactRetry.json()).toMatchObject({
    complete: true,
    outcomes: [{ status: 'stale', score: { status: 'stale', reason: 'own_vote_changed' } }],
  });
  const changedUpload = await f.send(importer.bearer, 'POST', base + ':preview', {
    upload: JSON.stringify([{ score: 8 }]),
    scoreFormat: 'POINT_10',
  });
  expect(changedUpload.status).toBe(200);
  const changedPath = base + '/' + (await changedUpload.json()).id;
  const changedReview = await f.send(importer.bearer, 'POST', changedPath + ':review', {
    ordinal: 0,
    subjectId,
    fields: [],
    replace: true,
    score: { action: 'vote', questionId: STANDARD_QUESTION_ID, questionRevision: 1, units: 16 },
  });
  expect(changedReview.status).toBe(200);
  const changedChoice = (await changedReview.json()).review;
  const changedConfirmation = { ordinal: 0, reviewId: changedChoice.id, confirmNativeVoteEffects: true };
  expect(await apply([changedConfirmation], changedPath)).toMatchObject({
    complete: true,
    outcomes: [{ status: 'applied', score: { status: 'applied' }, retained: [] }],
  });
  expect(await votes.readOwnVote(importer.actor, STANDARD_QUESTION_ID, subjectId)).toMatchObject({ units: 16 });
  const changedPage = await f.send(importer.bearer, 'GET', changedPath);
  expect(changedPage.status).toBe(200);
  const changedRow = (await changedPage.json()).rows[0];
  expect(changedRow.source.evidence.score).toBe(8);
  expect(changedRow.currentScore.vote).toMatchObject({ units: 16 });
  expect(changedRow.review.score.native.commandKey).toBe(changedChoice.score.native.commandKey);
  expect(await apply([changedConfirmation], changedPath)).toMatchObject({ complete: true });
  const refreshedScore = await f.send(importer.bearer, 'POST', path2 + ':review', {
    ordinal: 1,
    subjectId,
    fields: [],
    score: { action: 'vote', questionId: STANDARD_QUESTION_ID, questionRevision: 1, units: 12 },
  });
  expect(refreshedScore.status).toBe(409);
  const foreignScoreApply = await f.send('other', 'POST', path2 + ':apply', {
    confirmations: [{ ...scoreConfirmation, confirmNativeVoteEffects: true }],
  });
  expect(foreignScoreApply.status).toBe(404);
  const mangaId = mediaId + 1000000;
  const mangaUpload = await f.send(importer.bearer, 'POST', base + ':preview', {
    upload: JSON.stringify([
      { mediaId: mangaId, media: { id: mangaId, type: 'MANGA' }, progress: 0, progressVolumes: 2 },
    ]),
  });
  expect(mangaUpload.status).toBe(200);
  const mangaPath = base + '/' + (await mangaUpload.json()).id;
  const mangaReviewResponse = await f.send(importer.bearer, 'POST', mangaPath + ':review', {
    ordinal: 0,
    subjectId,
    fields: [],
    progress: {
      occurrence: { kind: 'start', primaryUnit: 'chapter' },
      measures: [
        { field: 'progress', action: 'adopt' },
        { field: 'progressVolumes', action: 'adopt' },
      ],
    },
  });
  expect(mangaReviewResponse.status).toBe(200);
  const mangaReview = (await mangaReviewResponse.json()).review;
  const mangaApplied = await f.send(importer.bearer, 'POST', mangaPath + ':apply', {
    confirmations: [{ ordinal: 0, reviewId: mangaReview.id }],
  });
  expect(mangaApplied.status).toBe(200);
  expect((await mangaApplied.json()).outcomes[0].progress).toMatchObject({
    occurrence: null,
    complete: true,
    measures: [
      { status: 'unsupported', unit: 'chapter' },
      { status: 'unsupported', unit: 'volume' },
    ],
  });
  const conflicts = await f.send(importer.bearer, 'POST', base + ':preview', {
    upload: JSON.stringify([
      { mediaId, media: { idMal: mediaId }, status: 'PLANNING', customLists: { Personal: true } },
      { status: 'PLANNING' },
      { status: 'PLANNING', score: null },
    ]),
    scoreFormat: 'POINT_10',
  });
  const path3 = base + '/' + (await conflicts.json()).id;
  const ambiguous = await (await f.send(importer.bearer, 'GET', path3)).json();
  expect(ambiguous.rows[0].match.state).toBe('ambiguous');
  expect(ambiguous.rows[0].match.candidates).toHaveLength(2);
  expect((await f.send(importer.bearer, 'POST', path3 + ':review', { ordinal: 0, fields: ['status'] })).status).toBe(
    409,
  );
  const label = await f.send(importer.bearer, 'POST', '/v1/libraryLabels', { name: 'Explicit ambiguous choice' });
  expect(label.status).toBe(201);
  const selections = [{ key: 'customLists:Personal', target: { labelId: (await label.json()).label.id } }];
  expect((await f.send(importer.bearer, 'POST', path3 + ':reviewLabels', { ordinal: 0, selections })).status).toBe(409);
  const labelReview = await f.send(importer.bearer, 'POST', path3 + ':reviewLabels', {
    ordinal: 0,
    subjectId,
    selections,
  });
  expect(labelReview.status).toBe(200);
  const labelApply = await f.send(importer.bearer, 'POST', path3 + ':applyLabels', {
    confirmations: [{ ordinal: 0, reviewId: (await labelReview.json()).review.id }],
  });
  expect(labelApply.status).toBe(200);
  expect((await labelApply.json()).outcomes[0].items[0].status).toBe('applied');
  const clearChoiceResponse = await f.send(importer.bearer, 'POST', path3 + ':review', {
    ordinal: 2,
    subjectId,
    fields: [],
    score: { action: 'clear', questionId: STANDARD_QUESTION_ID, questionRevision: 1 },
  });
  expect(clearChoiceResponse.status).toBe(200);
  expect((await clearChoiceResponse.json()).review.score).toMatchObject({
    source: { value: null, lexeme: null, scale: 'POINT_10', validity: 'unknown' },
    action: 'clear',
    units: null,
  });
  const clearChoice = (await clearChoiceResponse.json()).review;
  expect(await apply([{ ordinal: 2, reviewId: clearChoice.id, confirmNativeVoteEffects: true }], path3)).toMatchObject({
    complete: true,
    outcomes: [{ status: 'applied', score: { status: 'applied' }, retained: [] }],
  });
  expect(await votes.readOwnVote(importer.actor, STANDARD_QUESTION_ID, subjectId)).toBeNull();
  expect((await (await f.send(importer.bearer, 'GET', path3)).json()).rows[2].currentScore.vote).toBeNull();
  const guarded = await review(1, { subjectId, fields: ['status'], replace: true }, path3);
  const before = (await (await f.send(importer.bearer, 'GET', `/v1/libraryEntries/${subjectId}`)).json()).libraryEntry;
  const changed = await f.send(importer.bearer, 'PUT', `/v1/libraryEntries/${subjectId}`, {
    state: 'planned',
    revision: before.revision,
    incarnationId: before.incarnationId,
  });
  expect(changed.status).toBe(200);
  expect((await apply([guarded], path3)).outcomes[0].status).toBe('stale');
  const pending = await review(2, { subjectId, fields: ['status'] }, path3);
  expect((await f.send(importer.bearer, 'POST', path3 + ':cancel', {})).status).toBe(200);
  expect(await apply([pending], path3)).toEqual({ outcomes: [], complete: false });
  expect((await f.send(importer.bearer, 'POST', base + ':preview', { upload: '{' })).status).toBe(400);
  expect((await f.send(importer.bearer, 'POST', base + ':preview', { upload: ' '.repeat(1048577) })).status).toBe(413);
  await f.revokeIdentity(importer.actor.accountId);
  expect((await f.send(importer.bearer, 'GET', path)).status).toBeGreaterThanOrEqual(401);
  const denied = await f.send(importer.bearer, 'POST', path + ':apply', { confirmations: [first] });
  expect(denied.status).toBeGreaterThanOrEqual(401);
  const datesDenied = await f.send(importer.bearer, 'POST', `${path}/dates/apply`, {
    confirm: true,
    rows: [{ ordinal: 0, version: first.reviewId, fields: ['startDate'] }],
  });
  expect(datesDenied.status).toBeGreaterThanOrEqual(401);
}, 120000);
