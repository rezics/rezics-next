import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createSourceStatisticIsolationFixture, type IsolationActor } from './source-statistic-isolation-fixture.ts';

const fixtureOptions = { withRatingWorker: true };
let fixture: Awaited<ReturnType<typeof createSourceStatisticIsolationFixture>>;
let importedTargetId: string | undefined;
let expectedImportedEnvelope: SourceStatistic | undefined;

type SourceStatistic = {
  source: 'vndb';
  sourceRecordId: string;
  scale: { min: number; max: number };
  mean: number;
  count: number;
  asOf: string;
  licence: string;
  attribution: string;
};

function envelope(value: Omit<SourceStatistic, 'source'>): SourceStatistic {
  return { source: 'vndb', ...value };
}

async function readJson(response: Response, status = 200): Promise<unknown> {
  const body = await response.clone().text();
  if (response.status !== status) throw new Error(`Expected HTTP ${status}, received ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

async function readProblem(response: Response, status: number): Promise<Record<string, unknown>> {
  const body = await readJson(response, status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(typeof body).toBe('object');
  return body as Record<string, unknown>;
}

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 60_000;
  let value = await read();
  while (!ready(value) && Date.now() < deadline) {
    await Bun.sleep(25);
    value = await read();
  }
  if (!ready(value)) {
    const pending = await fixture.database.admin.query(
      `SELECT consumer, partition_no, position FROM core.consumer_checkpoint
       ORDER BY consumer, partition_no LIMIT 12`,
    );
    const activity = await fixture.database.admin.query(
      `SELECT state, wait_event_type, wait_event FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    throw new Error(
      `${label} did not reach its committed-event barrier: ${JSON.stringify({ value, pending: pending.rows, activity: activity.rows })}`,
    );
  }
  return value;
}

async function figure(subjectId: string) {
  const response = await fixture.request('GET', `/v1/subjects/${subjectId}/figure`, { actor: null });
  return (await readJson(response)) as {
    figure: {
      questionId: string;
      populationId: string;
      scale: { min: number; max: number; displayStep: number };
      count: number;
      state: string;
      mean: number | null;
      score: number | null;
    };
  };
}

async function aggregate(subjectId: string) {
  const response = await fixture.request(
    'GET',
    `/v1/subjects/${subjectId}/ratings?question=${STANDARD_QUESTION_ID}&population=${GLOBAL_CONTEXT.id}`,
    { actor: null },
  );
  return (await readJson(response)) as {
    question: string;
    subject: string;
    figures: Array<{
      population: string;
      count: number;
      mean?: number;
      histogram?: number[];
      freshness: { asOf: string | null; updating: boolean };
    }>;
  };
}

async function sourceStatistics(subjectId: string, actor: IsolationActor | null = null): Promise<SourceStatistic[]> {
  const response = await fixture.request('GET', `/v1/subjects/${subjectId}/source-statistics`, { actor });
  return (await readJson(response)) as SourceStatistic[];
}

async function mutationState(subjectId: string): Promise<unknown> {
  const route = routeOf(subjectId)!;
  const partition = route >>> 4;
  const result = await fixture.database.admin.query(
    `SELECT
       (SELECT count(*)::integer FROM core.receipt WHERE partition_no = $2) AS receipts,
       (SELECT count(*)::integer FROM core.outbox WHERE partition_no = $2) AS outbox,
       (SELECT count(*)::integer FROM editorial.write_basis WHERE partition_no = $2) AS write_basis,
       (SELECT position::text FROM core.partition WHERE partition_no = $2) AS position,
       (SELECT count(*)::integer FROM rating.source_statistic WHERE route = $1 AND subject_id = $3) AS statistics,
       (SELECT count(*)::integer FROM rating.vote WHERE target_id = $3) AS votes,
       (SELECT count(*)::integer FROM rating.aggregate_component WHERE target_id = $3) AS aggregate_components,
       (SELECT count(*)::integer FROM rating.public_figure WHERE subject_id = $3) AS figures,
       (SELECT to_jsonb(subject) FROM semantic.subject AS subject WHERE route = $1 AND subject_id = $3) AS subject`,
    [route, partition, subjectId],
  );
  return result.rows[0];
}

type NativePriorProgress = {
  committedVotes: string;
  sourceEvents: string;
  deliveredEvents: string;
  appliedVotes: string;
  aggregateCount: string;
  aggregateSum: string;
  totalCount: string;
  totalSum: string;
  priorStartCount: string | null;
  priorMean: string | null;
  priorThreshold: string | null;
  publishedFigures: string;
};

async function nativePriorProgress(subjectIds: readonly string[]): Promise<NativePriorProgress> {
  const result = await fixture.database.admin.query<NativePriorProgress>(
    `WITH source_votes AS MATERIALIZED (
       SELECT vote.route, vote.voter_id, vote.question_id, vote.target_id, vote.transaction_id
       FROM rating.vote AS vote
       WHERE vote.question_id = $2 AND vote.target_id = ANY($1::uuid[]) AND vote.units = 4
     ), source_events AS MATERIALIZED (
       SELECT receipt.partition_no, receipt.epoch, receipt.position, event.id
       FROM source_votes AS vote
       JOIN core.receipt AS receipt
         ON receipt.partition_no = (vote.route >> 4) AND receipt.transaction_id = vote.transaction_id
       JOIN core.outbox AS event
         ON event.partition_no = receipt.partition_no AND event.position = receipt.position
        AND event.type = 'com.rezics.rating.vote.changed.v1'
        AND event.data ->> 'targetId' = vote.target_id::text
     )
     SELECT
       (SELECT count(*)::text FROM source_votes) AS "committedVotes",
       (SELECT count(*)::text FROM source_events) AS "sourceEvents",
       (SELECT count(*)::text FROM source_events AS event
        JOIN core.consumer_checkpoint AS checkpoint
          ON checkpoint.partition_no = event.partition_no AND checkpoint.consumer = 'effects'
         AND (checkpoint.epoch > event.epoch OR
              (checkpoint.epoch = event.epoch AND checkpoint.position >= event.position))) AS "deliveredEvents",
       (SELECT count(*)::text FROM rating.population_vote AS vote
        WHERE vote.question_id = $2 AND vote.population_id = $3
          AND vote.target_id = ANY($1::uuid[]) AND vote.units = 4) AS "appliedVotes",
       (SELECT coalesce(sum(component.count), 0)::text FROM rating.aggregate_component AS component
        WHERE component.question_id = $2 AND component.population_id = $3
          AND component.target_id = ANY($1::uuid[])) AS "aggregateCount",
       (SELECT coalesce(sum(component.sum), 0)::text FROM rating.aggregate_component AS component
        WHERE component.question_id = $2 AND component.population_id = $3
          AND component.target_id = ANY($1::uuid[])) AS "aggregateSum",
       (SELECT coalesce(sum(component.count), 0)::text FROM rating.population_total_component AS component
        WHERE component.question_id = $2 AND component.population_id = $3) AS "totalCount",
       (SELECT coalesce(sum(component.sum), 0)::text FROM rating.population_total_component AS component
        WHERE component.question_id = $2 AND component.population_id = $3) AS "totalSum",
       (SELECT epoch.start_count::text FROM rating.population_prior_epoch AS epoch
        WHERE epoch.question_id = $2 AND epoch.population_id = $3) AS "priorStartCount",
       (SELECT epoch.m::text FROM rating.population_prior_epoch AS epoch
        WHERE epoch.question_id = $2 AND epoch.population_id = $3) AS "priorMean",
       (SELECT epoch.c::text FROM rating.population_prior_epoch AS epoch
        WHERE epoch.question_id = $2 AND epoch.population_id = $3) AS "priorThreshold",
       (SELECT count(*)::text FROM rating.public_figure AS figure
        WHERE figure.question_id = $2 AND figure.population_id = $3
          AND figure.subject_id = ANY($1::uuid[]) AND figure.count = 5
          AND figure.mean = 2 AND figure.score = 2) AS "publishedFigures"`,
    [subjectIds, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id],
  );
  return result.rows[0]!;
}

async function castVote(subjectId: string, voter: IsolationActor, units: number): Promise<void> {
  const response = await fixture.request('PUT', `/v1/subjects/${subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`, {
    actor: voter,
    body: { units },
    key: randomUUID(),
  });
  await readJson(response);
}

beforeAll(async () => {
  fixture = await createSourceStatisticIsolationFixture(fixtureOptions);
}, 180_000);

afterAll(async () => {
  await fixture?.close();
});

test('Ratings and reviews: imported statistics stay labelled, independently authorized and separate from native figures.', async () => {
  const subjectId = await fixture.createSubject('Imported and native rating isolation target');
  importedTargetId = subjectId;
  const otherSubjectId = await fixture.createSubject('Independent imported statistic target');
  const hiddenSubjectId = await fixture.createSubject('Hidden source statistic target');
  await fixture.grantImporter(fixture.actors.importer);
  await fixture.grantImporter(fixture.actors.secondImporter);

  const firstValue = {
    sourceRecordId: 'vndb-record-season-17',
    scale: { min: 7, max: 813 },
    mean: 427.125,
    count: 7_654_321,
    asOf: '2026-10-28',
    licence: 'Creative Commons Attribution-NonCommercial 4.0 International',
    attribution: 'VNDB import team, snapshot 2026-10-28.',
  };
  const refreshedValue = {
    sourceRecordId: 'vndb-record-revised-season-17',
    scale: { min: 13, max: 4096 },
    mean: 4095.75,
    count: 2_147_483_647,
    asOf: '2026-10-01',
    licence: 'VNDB data licence, revision 2',
    attribution: 'VNDB import team, revised snapshot 2026-10-01.',
  };
  const otherSubjectValue = {
    sourceRecordId: 'vndb-independent-subject-record',
    scale: { min: 0, max: 100 },
    mean: 61.375,
    count: 321,
    asOf: '2026-10-20',
    licence: 'CC BY 4.0 - independent record',
    attribution: 'Independent subject attribution.',
  };
  const otherEnvelope = envelope(otherSubjectValue);

  const otherBeforeRefresh = await fixture.request('PUT', `/v1/subjects/${otherSubjectId}/source-statistics/vndb`, {
    actor: fixture.actors.secondImporter,
    body: otherSubjectValue,
    key: randomUUID(),
  });
  expect(await readJson(otherBeforeRefresh)).toEqual({ source: 'vndb', ...otherSubjectValue });

  const originalKey = randomUUID();
  const firstWrite = await fixture.request('PUT', `/v1/subjects/${subjectId}/source-statistics/vndb`, {
    actor: fixture.actors.importer,
    body: firstValue,
    key: originalKey,
  });
  const firstEnvelope = envelope(firstValue);
  expect(await readJson(firstWrite)).toEqual(firstEnvelope);
  const replay = await fixture.request('PUT', `/v1/subjects/${subjectId}/source-statistics/vndb`, {
    actor: fixture.actors.importer,
    body: firstValue,
    key: originalKey,
  });
  expect(await readJson(replay)).toEqual(firstEnvelope);
  expect(await sourceStatistics(subjectId, fixture.actors.importer)).toEqual([firstEnvelope]);

  const refreshKey = randomUUID();
  // The documented source contract replaces the slot; a stale asOf is still accepted as current source data.
  const refresh = await fixture.request('PUT', `/v1/subjects/${subjectId}/source-statistics/vndb`, {
    actor: fixture.actors.importer,
    body: refreshedValue,
    key: refreshKey,
  });
  const refreshedEnvelope = envelope(refreshedValue);
  expectedImportedEnvelope = refreshedEnvelope;
  expect(await readJson(refresh)).toEqual(refreshedEnvelope);
  expect(await sourceStatistics(subjectId, fixture.actors.importer)).toEqual([refreshedEnvelope]);
  expect(await sourceStatistics(otherSubjectId, fixture.actors.secondImporter)).toEqual([otherEnvelope]);

  const changedIntent = await fixture.request('PUT', `/v1/subjects/${subjectId}/source-statistics/vndb`, {
    actor: fixture.actors.importer,
    body: { ...firstValue, mean: 427.126 },
    key: originalKey,
  });
  expect(await readProblem(changedIntent, 422)).toMatchObject({ code: 'idempotency_conflict' });

  const ownerAttempt = await fixture.request('PUT', `/v1/subjects/${subjectId}/source-statistics/vndb`, {
    actor: fixture.actors.author,
    body: { ...refreshedValue, sourceRecordId: 'owner-without-importer-grant' },
    key: randomUUID(),
  });
  expect(await readProblem(ownerAttempt, 403)).toMatchObject({ code: 'forbidden' });
  expect(await sourceStatistics(subjectId, fixture.actors.importer)).toEqual([refreshedEnvelope]);

  await fixture.revokeImporter(fixture.actors.importer);
  const beforeDeniedRequests = await mutationState(subjectId);
  const revokedReplay = await fixture.request('PUT', `/v1/subjects/${subjectId}/source-statistics/vndb`, {
    actor: fixture.actors.importer,
    body: firstValue,
    key: originalKey,
  });
  const revokedReplayProblem = await readProblem(revokedReplay, 403);
  for (const privateValue of [firstValue, refreshedValue]) {
    expect(JSON.stringify(revokedReplayProblem)).not.toContain(privateValue.sourceRecordId);
    expect(JSON.stringify(revokedReplayProblem)).not.toContain(privateValue.licence);
    expect(JSON.stringify(revokedReplayProblem)).not.toContain(privateValue.attribution);
  }
  const revokedNewWrite = await fixture.request('PUT', `/v1/subjects/${subjectId}/source-statistics/vndb`, {
    actor: fixture.actors.importer,
    body: { ...refreshedValue, sourceRecordId: 'revoked-new-source-record' },
    key: randomUUID(),
  });
  expect(await readProblem(revokedNewWrite, 403)).toMatchObject({ code: 'forbidden' });
  expect(await mutationState(subjectId)).toEqual(beforeDeniedRequests);

  const secondImporterWrite = await fixture.request('PUT', `/v1/subjects/${hiddenSubjectId}/source-statistics/vndb`, {
    actor: fixture.actors.secondImporter,
    body: {
      sourceRecordId: 'private-attribution-sentinel-record',
      scale: { min: 0, max: 10 },
      mean: 8.5,
      count: 999,
      asOf: '2026-10-25',
      licence: 'Private attribution sentinel licence',
      attribution: 'Private attribution sentinel attribution.',
    },
    key: randomUUID(),
  });
  expect(secondImporterWrite.status).toBe(200);
  expect(await sourceStatistics(otherSubjectId, fixture.actors.secondImporter)).toEqual([otherEnvelope]);

  const hide = await fixture.request('POST', `/v1/subjects/${hiddenSubjectId}:hide`, {
    actor: fixture.actors.governance,
    body: { reason: 'Source visibility boundary acceptance case.' },
    key: randomUUID(),
  });
  expect(hide.status).toBe(200);
  const hiddenRead = await fixture.request('GET', `/v1/subjects/${hiddenSubjectId}/source-statistics`, {
    actor: fixture.actors.secondImporter,
  });
  const hiddenProblem = await readProblem(hiddenRead, 404);
  const hiddenOwnerRead = await fixture.request('GET', `/v1/subjects/${hiddenSubjectId}/source-statistics`, {
    actor: fixture.actors.author,
  });
  const hiddenOwnerProblem = await readProblem(hiddenOwnerRead, 404);
  const unknownSubjectId = newId(routeOf(hiddenSubjectId)!);
  const unknownRead = await fixture.request('GET', `/v1/subjects/${unknownSubjectId}/source-statistics`, {
    actor: fixture.actors.secondImporter,
  });
  const unknownProblem = await readProblem(unknownRead, 404);
  const withoutRequestId = (problem: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(problem).filter(([field]) => field !== 'request_id'));
  expect(withoutRequestId(hiddenProblem)).toEqual(withoutRequestId(unknownProblem));
  expect(withoutRequestId(hiddenOwnerProblem)).toEqual(withoutRequestId(unknownProblem));
  for (const responseProblem of [hiddenProblem, hiddenOwnerProblem]) {
    expect(JSON.stringify(responseProblem)).not.toContain('private-attribution-sentinel-record');
    expect(JSON.stringify(responseProblem)).not.toContain('Private attribution sentinel licence');
    expect(JSON.stringify(responseProblem)).not.toContain('Private attribution sentinel attribution.');
  }
});

test('A large imported count does not seed a native mean, prior, or score.', async () => {
  if (!importedTargetId || !expectedImportedEnvelope)
    throw new Error('The source-statistic isolation HTTP case did not produce its imported target');
  const subjectId = importedTargetId;
  const refreshedEnvelope = expectedImportedEnvelope;

  const standardQuestionResponse = await fixture.request('GET', `/v1/rating-questions/${STANDARD_QUESTION_ID}`, {
    actor: null,
  });
  const standardQuestion = (await readJson(standardQuestionResponse)) as {
    id: string;
    grain: string;
    scale: { min: number; max: number; displayStep: number };
  };
  expect(standardQuestion).toMatchObject({
    id: STANDARD_QUESTION_ID,
    grain: 'work',
    scale: { min: 0, max: 20, displayStep: 1 },
  });

  expect(await sourceStatistics(subjectId, fixture.actors.author)).toEqual([refreshedEnvelope]);
  const figureBeforeVotes = await figure(subjectId);
  expect(figureBeforeVotes.figure).toMatchObject({
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
    scale: { min: 0, max: 20, displayStep: 1 },
    count: 0,
    state: 'insufficient_data',
    mean: null,
    score: null,
  });
  const aggregateBeforeVotes = await aggregate(subjectId);
  expect(aggregateBeforeVotes).toMatchObject({
    question: STANDARD_QUESTION_ID,
    subject: subjectId,
    figures: [{ population: GLOBAL_CONTEXT.id, count: 0 }],
  });
  expect(aggregateBeforeVotes.figures[0]).not.toHaveProperty('mean');
  expect(aggregateBeforeVotes.figures[0]).not.toHaveProperty('histogram');
  const noNativeRows = await fixture.database.admin.query(
    `SELECT
       (SELECT count(*)::integer FROM rating.vote WHERE target_id = $1) AS votes,
       (SELECT count(*)::integer FROM rating.population_vote WHERE target_id = $1) AS population_votes,
       (SELECT count(*)::integer FROM rating.aggregate_component WHERE target_id = $1) AS aggregates,
       (SELECT count(*)::integer FROM rating.public_figure WHERE subject_id = $1) AS figures,
       (SELECT coalesce(sum(count), 0)::text FROM rating.population_total_component
        WHERE question_id = $3 AND population_id = $4) AS population_count,
       (SELECT count(*)::integer FROM rating.population_prior_epoch
        WHERE question_id = $3 AND population_id = $4) AS prior_epochs,
       (SELECT count::text FROM rating.source_statistic WHERE route = $2 AND subject_id = $1 AND source = 'vndb') AS imported_count`,
    [subjectId, routeOf(subjectId), STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id],
  );
  expect(noNativeRows.rows).toEqual([
    {
      votes: 0,
      population_votes: 0,
      aggregates: 0,
      figures: 0,
      population_count: '0',
      prior_epochs: 0,
      imported_count: '2147483647',
    },
  ]);

  // Native prior epochs require 50 counted votes; imported counts remain source-local.
  expect(fixture.actors.voters).toHaveLength(5);
  const priorSubjects: string[] = [];
  for (let index = 0; index < 10; index++)
    priorSubjects.push(await fixture.createSubject(`Native prior source isolation ${index + 1}`));
  for (const priorSubject of priorSubjects)
    for (const voter of fixture.actors.voters) await castVote(priorSubject, voter, 4);

  // Join each real vote to its committed event and wait for the registered rating effect and figure drain.
  // The broader prior-epoch suite owns republishing unrelated rated siblings.
  const priorProgress = await until(
    () => nativePriorProgress(priorSubjects),
    (value) =>
      value.committedVotes === '50' &&
      value.sourceEvents === '50' &&
      value.deliveredEvents === '50' &&
      value.appliedVotes === '50' &&
      value.aggregateCount === '50' &&
      value.aggregateSum === '200' &&
      value.totalCount === '50' &&
      value.totalSum === '200' &&
      value.priorStartCount === '50' &&
      value.priorMean === '2.0000' &&
      value.priorThreshold === '5' &&
      value.publishedFigures === '10',
    'Native Global prior results for the ten real prior subjects',
  );
  expect(priorProgress).toEqual({
    committedVotes: '50',
    sourceEvents: '50',
    deliveredEvents: '50',
    appliedVotes: '50',
    aggregateCount: '50',
    aggregateSum: '200',
    totalCount: '50',
    totalSum: '200',
    priorStartCount: '50',
    priorMean: '2.0000',
    priorThreshold: '5',
    publishedFigures: '10',
  });
  const priorFigures = await Promise.all(priorSubjects.map((priorSubject) => figure(priorSubject)));
  for (const priorFigure of priorFigures)
    expect(priorFigure.figure).toMatchObject({ count: 5, state: 'ready', mean: 2, score: 2 });

  for (const voter of fixture.actors.voters) await castVote(subjectId, voter, 20);
  const publishedFigure = await until(
    () => figure(subjectId),
    (value) =>
      value.figure.count === 5 &&
      value.figure.state === 'ready' &&
      value.figure.mean === 10 &&
      value.figure.score === 6,
    'Native figure after five actual votes',
  );
  expect(publishedFigure.figure).toEqual({
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
    scale: { min: 0, max: 20, displayStep: 1 },
    count: 5,
    state: 'ready',
    mean: 10,
    score: 6,
  });

  const nativeAggregate = await until(
    () => aggregate(subjectId),
    (value) => value.figures[0]?.count === 5 && value.figures[0]?.mean === 20,
    'Native Global aggregate after five actual votes',
  );
  expect(nativeAggregate.figures[0]).toMatchObject({
    population: GLOBAL_CONTEXT.id,
    count: 5,
    mean: 20,
  });
  expect(nativeAggregate.figures[0]!.histogram).toHaveLength(21);
  expect(nativeAggregate.figures[0]!.histogram![20]).toBe(5);

  const nativeOutcome = await fixture.database.admin.query<{
    target_votes: string;
    population_votes: string;
    aggregate_count: string;
    aggregate_sum: string;
    prior_start_count: string | null;
    prior_mean: string | null;
    total_count: string;
    total_sum: string;
    figure_count: string;
    figure_mean: string;
    figure_score: string | null;
    figure_prior_mean: string | null;
    imported_count: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM rating.vote WHERE target_id = $1 AND question_id = $2) AS target_votes,
       (SELECT count(*)::text FROM rating.population_vote WHERE target_id = $1 AND question_id = $2 AND population_id = $3) AS population_votes,
       (SELECT coalesce(sum(count), 0)::text FROM rating.aggregate_component WHERE target_id = $1 AND question_id = $2 AND population_id = $3) AS aggregate_count,
       (SELECT coalesce(sum(sum), 0)::text FROM rating.aggregate_component WHERE target_id = $1 AND question_id = $2 AND population_id = $3) AS aggregate_sum,
       (SELECT start_count::text FROM rating.population_prior_epoch WHERE question_id = $2 AND population_id = $3) AS prior_start_count,
       (SELECT m::text FROM rating.population_prior_epoch WHERE question_id = $2 AND population_id = $3) AS prior_mean,
       (SELECT coalesce(sum(count), 0)::text FROM rating.population_total_component WHERE question_id = $2 AND population_id = $3) AS total_count,
       (SELECT coalesce(sum(sum), 0)::text FROM rating.population_total_component WHERE question_id = $2 AND population_id = $3) AS total_sum,
       (SELECT count::text FROM rating.public_figure WHERE route = $4 AND subject_id = $1 AND question_id = $2 AND population_id = $3) AS figure_count,
       (SELECT mean::text FROM rating.public_figure WHERE route = $4 AND subject_id = $1 AND question_id = $2 AND population_id = $3) AS figure_mean,
       (SELECT score::text FROM rating.public_figure WHERE route = $4 AND subject_id = $1 AND question_id = $2 AND population_id = $3) AS figure_score,
       (SELECT m::text FROM rating.public_figure WHERE route = $4 AND subject_id = $1 AND question_id = $2 AND population_id = $3) AS figure_prior_mean,
       (SELECT count::text FROM rating.source_statistic WHERE route = $4 AND subject_id = $1 AND source = 'vndb') AS imported_count`,
    [subjectId, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id, routeOf(subjectId)],
  );
  expect(nativeOutcome.rows).toEqual([
    {
      target_votes: '5',
      population_votes: '5',
      aggregate_count: '5',
      aggregate_sum: '100',
      prior_start_count: '50',
      prior_mean: '2.0000',
      total_count: '55',
      total_sum: '300',
      figure_count: '5',
      figure_mean: '10.0000',
      figure_score: '6.0000',
      figure_prior_mean: '2.0000',
      imported_count: '2147483647',
    },
  ]);
  expect((await sourceStatistics(subjectId, fixture.actors.author))[0]).toEqual(refreshedEnvelope);

  // Full prior epoch and sibling republish behavior is covered by prior-epoch.test.ts.
});

test('invalid strict source-statistic JSON and provenance domains reject without native or command mutations', async () => {
  const subjectId = await fixture.createSubject('Rejected source statistic atomicity target');
  await fixture.grantImporter(fixture.actors.importer);
  const validValue = {
    sourceRecordId: 'valid-vndb-record',
    scale: { min: 0, max: 10 },
    mean: 8.5,
    count: 100,
    asOf: '2026-10-20',
    licence: 'CC BY 4.0',
    attribution: 'VNDB users',
  };
  const invalid: Array<{ name: string; path?: string; body?: unknown; rawBody?: string }> = [
    { name: 'unknown JSON property', body: { ...validValue, importedScore: 9 } },
    { name: 'unsupported source path', path: 'bangumi', body: validValue },
    {
      name: 'scale maximum beyond the current 4096 domain',
      body: { ...validValue, scale: { min: 0, max: 4097 }, mean: 8.5 },
    },
    { name: 'scale with no positive interval', body: { ...validValue, scale: { min: 10, max: 10 }, mean: 10 } },
    { name: 'mean outside the accepted scale', body: { ...validValue, mean: 10.01 } },
    { name: 'count beyond the current int32 schema maximum', body: { ...validValue, count: 2_147_483_648 } },
    { name: 'non-calendar date', body: { ...validValue, asOf: '2026-02-30' } },
    {
      name: 'attribution beyond the current 2000-character schema maximum',
      body: { ...validValue, attribution: 'a'.repeat(2001) },
    },
    { name: 'empty source record id', body: { ...validValue, sourceRecordId: '' } },
    { name: 'empty licence', body: { ...validValue, licence: '' } },
    { name: 'malformed JSON object', rawBody: '{"sourceRecordId":' },
  ];

  for (const item of invalid) {
    const before = await mutationState(subjectId);
    const response = await fixture.request(
      'PUT',
      `/v1/subjects/${subjectId}/source-statistics/${item.path ?? 'vndb'}`,
      {
        actor: fixture.actors.importer,
        ...(item.body === undefined ? {} : { body: item.body }),
        ...(item.rawBody === undefined ? {} : { rawBody: item.rawBody }),
        key: randomUUID(),
      },
    );
    expect(response.status, item.name).toBe(400);
    const problem = await response.json();
    expect(problem, item.name).toMatchObject({ code: 'invalid_request' });
    expect(await mutationState(subjectId), item.name).toEqual(before);
  }
});
