import { expect, test } from 'bun:test';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
} from '../support/growth.ts';
import {
  createRestoreScenario,
  createRevisionHistory,
  ensureSelectedReviewRestoredForWarmup,
  growRetainedRevisionHistory,
  originalTitle,
  restoreBody,
  restoreBodyBytes,
  restoreBodyDigest,
  restoreSelectedReview,
  scales,
  unrelatedReviewPopulation,
  type RestoreScenario,
} from './support/growth-review-restore-success-fixture.ts';
import { requestKey } from './review-native-lifecycle-fixture.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';

type CommandHistory = Readonly<{ threads: number; votes: number; revisions: number; receipts: number; outbox: number }>;

async function openGrowth(scenario: RestoreScenario): Promise<GrowthDatabase> {
  const connectionString = scenario.fixture.system.database.pool.options.connectionString;
  if (typeof connectionString !== 'string') throw new Error('Native content pool has no connection string');
  return openGrowthDatabase(connectionString);
}

async function liveSlot(scenario: RestoreScenario) {
  const { fixture, original } = scenario;
  const route = routeOf(fixture.author.accountId)!;
  return fixture.admin.query<{ thread_id: string }>(
    `SELECT thread_id
     FROM content.thread
     WHERE route = $1 AND author_account_id = $2 AND board_id = $3 AND review_subject_id = $4
       AND kind = 'review' AND review_live AND availability = 'available' AND visibility <> 'taken_down'`,
    [route, fixture.author.accountId, fixture.boardId, original.subjectId],
  );
}

async function reviewSnapshot(scenario: RestoreScenario) {
  const { fixture, original } = scenario;
  const route = routeOf(fixture.author.accountId)!;
  const partition = partitionOf(route);
  const [position, receipts, outbox, thread, post, revisions, vote, slots] = await Promise.all([
    fixture.admin.query('SELECT epoch, position::text FROM core.partition WHERE partition_no = $1', [partition]),
    fixture.admin.query(
      'SELECT count(*)::integer AS count FROM core.receipt WHERE partition_no = $1 AND principal_id = $2',
      [partition, fixture.author.accountId],
    ),
    fixture.admin.query('SELECT count(*)::integer AS count FROM core.outbox WHERE partition_no = $1', [partition]),
    fixture.admin.query(
      'SELECT thread_id, author_account_id, board_id, review_subject_id, review_live, availability, visibility FROM content.thread WHERE route = $1 AND thread_id = $2',
      [route, original.threadId],
    ),
    fixture.admin.query(
      'SELECT post_id, head_revision_id, availability, deleted_at FROM content.post WHERE route = $1 AND thread_id = $2 AND post_id = $3',
      [route, original.threadId, original.postId],
    ),
    fixture.admin.query(
      'SELECT revision_id, body, body_sha256, licence, subject_ids, board_id, vote_citation FROM content.revision WHERE route = $1 AND thread_id = $2 ORDER BY revision_id',
      [route, original.threadId],
    ),
    fixture.admin.query(
      'SELECT question_id, target_id, units, revision FROM rating.vote WHERE route = $1 AND voter_id = $2 AND question_id = $3 AND target_id = $4',
      [route, fixture.author.accountId, STANDARD_QUESTION_ID, original.subjectId],
    ),
    liveSlot(scenario),
  ]);
  return {
    position: position.rows,
    receipts: receipts.rows,
    outbox: outbox.rows,
    thread: thread.rows,
    post: post.rows,
    revisions: revisions.rows,
    vote: vote.rows,
    slots: slots.rows,
  };
}

async function assertHiddenBeforeRestore(scenario: RestoreScenario): Promise<void> {
  const { fixture, original } = scenario;
  const thread = await fixture.call('GET', `/v1/threads/${original.threadId}`);
  expect(thread.response.status).toBe(200);
  expect(thread.value.thread.title).toBeNull();
  expect(thread.value.thread.firstPost).toMatchObject({
    id: original.postId,
    removed: true,
    availability: 'erased',
    body: null,
    sha256: null,
  });
  expect(thread.text).not.toContain('native review restored with its original licence and vote citation');
  expect(
    (await fixture.call('GET', `/v1/posts/${original.postId}/revisions/${original.revisionId}`)).response.status,
  ).toBe(404);
  expect((await fixture.call('GET', `/v1/boards/${fixture.boardId}`)).response.status).toBe(200);
  expect((await liveSlot(scenario)).rows).toEqual([]);
}

async function assertRestoredDisclosure(scenario: RestoreScenario): Promise<void> {
  const { fixture, originalCitation, original } = scenario;
  const route = routeOf(fixture.author.accountId)!;
  const thread = await fixture.call('GET', `/v1/threads/${original.threadId}`);
  expect(thread.response.status).toBe(200);
  expect(thread.value.thread).toMatchObject({
    id: original.threadId,
    route,
    authorId: fixture.author.accountId,
    kind: 'review',
    boardId: fixture.boardId,
    subjectIds: [original.subjectId],
    title: originalTitle,
    firstPost: {
      id: original.postId,
      revisionId: original.revisionId,
      voteCitation: originalCitation,
      availability: 'available',
    },
  });
  const exactRevision = await fixture.call('GET', `/v1/posts/${original.postId}/revisions/${original.revisionId}`, {
    bearer: fixture.author.bearer,
  });
  expect(exactRevision.response.status).toBe(200);
  expect(exactRevision.value.post).toMatchObject({
    id: original.postId,
    revisionId: original.revisionId,
    body: restoreBody,
    licence: 'CC-BY-4.0',
    subjectIds: [original.subjectId],
    boardId: fixture.boardId,
    voteCitation: originalCitation,
    availability: 'available',
  });
  const currentVote = await fixture.call(
    'GET',
    `/v1/subjects/${original.subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`,
    { bearer: fixture.author.bearer },
  );
  expect(currentVote.response.status).toBe(200);
  expect(currentVote.value).toMatchObject({ units: 12, revision: 2 });
  expect((await fixture.call('GET', `/v1/boards/${fixture.boardId}`)).value.board).toMatchObject({
    purpose: 'reviews',
    visibility: 'published',
    realmId: null,
  });
  expect((await liveSlot(scenario)).rows).toEqual([{ thread_id: original.threadId }]);

  const stored = await fixture.admin.query(
    'SELECT body, body_sha256, licence, subject_ids, board_id, vote_citation FROM content.revision WHERE route = $1 AND revision_id = $2',
    [route, original.revisionId],
  );
  expect(stored.rows).toEqual([
    {
      body: restoreBodyBytes,
      body_sha256: restoreBodyDigest,
      licence: 'CC-BY-4.0',
      subject_ids: [original.subjectId],
      board_id: fixture.boardId,
      vote_citation: originalCitation,
    },
  ]);
}

async function assertReplayAddsNoContribution(scenario: RestoreScenario, key: string): Promise<void> {
  const before = await reviewSnapshot(scenario);
  const replay = await scenario.fixture.call('POST', `/v1/posts/${scenario.original.postId}:restore`, {
    bearer: scenario.fixture.author.bearer,
    key,
  });
  expect(replay.response.status).toBe(204);
  expect(replay.text).toBe('');
  expect(await reviewSnapshot(scenario)).toEqual(before);
}

async function populationCounts(scenario: RestoreScenario, titlePrefix: string) {
  const { fixture } = scenario;
  const route = routeOf(fixture.author.accountId)!;
  const [threads, revisions, votes, receipts, outbox] = await Promise.all([
    fixture.admin.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM content.thread WHERE route = $1 AND author_account_id = $2 AND board_id = $3 AND title LIKE $4',
      [route, fixture.author.accountId, fixture.boardId, `${titlePrefix}%`],
    ),
    fixture.admin.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM content.revision r JOIN content.thread t USING (route, thread_id)
       WHERE r.route = $1 AND t.author_account_id = $2 AND t.board_id = $3 AND t.title LIKE $4`,
      [route, fixture.author.accountId, fixture.boardId, `${titlePrefix}%`],
    ),
    fixture.admin.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM rating.vote WHERE route = $1 AND voter_id = $2 AND question_id = $3 AND target_id <> $4',
      [route, fixture.author.accountId, STANDARD_QUESTION_ID, scenario.original.subjectId],
    ),
    fixture.admin.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM core.receipt WHERE partition_no = $1 AND principal_id = $2',
      [partitionOf(route), fixture.author.accountId],
    ),
    fixture.admin.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM core.outbox WHERE partition_no = $1',
      [partitionOf(route)],
    ),
  ]);
  return {
    threads: threads.rows[0]!.count,
    revisions: revisions.rows[0]!.count,
    votes: votes.rows[0]!.count,
    receipts: receipts.rows[0]!.count,
    outbox: outbox.rows[0]!.count,
  };
}

async function historyCounts(scenario: RestoreScenario, historyThreadId: string): Promise<CommandHistory> {
  const { fixture } = scenario;
  const route = routeOf(fixture.author.accountId)!;
  const partition = partitionOf(route);
  const [threads, votes, revisions, receipts, outbox] = await Promise.all([
    fixture.admin.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM content.thread WHERE route = $1 AND author_account_id = $2 AND board_id = $3',
      [route, fixture.author.accountId, fixture.boardId],
    ),
    fixture.admin.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM rating.vote WHERE route = $1 AND voter_id = $2',
      [route, fixture.author.accountId],
    ),
    fixture.admin.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM content.revision WHERE route = $1 AND thread_id = $2',
      [route, historyThreadId],
    ),
    fixture.admin.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM core.receipt WHERE partition_no = $1 AND principal_id = $2',
      [partition, fixture.author.accountId],
    ),
    fixture.admin.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM core.outbox WHERE partition_no = $1',
      [partition],
    ),
  ]);
  return {
    threads: threads.rows[0]!.count,
    votes: votes.rows[0]!.count,
    revisions: revisions.rows[0]!.count,
    receipts: receipts.rows[0]!.count,
    outbox: outbox.rows[0]!.count,
  };
}

async function assertGrowthReport(report: Awaited<ReturnType<typeof checkGrowth>>): Promise<void> {
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  for (const sample of report.samples) {
    expect(sample.repetitions).toHaveLength(1);
    expect(sample.statementRepetitions).toHaveLength(1);
    expect(sample.occurrenceRepetitions).toHaveLength(1);
    expect(sample.cost.statements).toBeGreaterThan(0);
    expect(sample.cost.rows).toBeGreaterThan(0);
    expect(sample.cost.sharedHit + sample.cost.sharedRead).toBeGreaterThan(0);
  }
  const measuredRelations = [
    ...new Set(
      report.samples.flatMap((sample) => sample.repetitions.flatMap((repetition) => Object.keys(repetition.relations))),
    ),
  ].sort();
  assertGrowthAccessPaths(report.name, report.samples, measuredRelations);
}

async function prepareForMeasurement(scenario: RestoreScenario): Promise<void> {
  const deleted = await scenario.fixture.call('DELETE', `/v1/posts/${scenario.original.postId}`, {
    bearer: scenario.fixture.author.bearer,
    key: requestKey('restore-success-measured-delete'),
  });
  expect(deleted.response.status, deleted.text).toBe(204);
}

async function runSuccessGrowth(
  scenario: RestoreScenario,
  growth: GrowthDatabase,
  name: string,
  grow: (database: GrowthDatabase, scale: number, previous: number) => Promise<void>,
): Promise<string> {
  const keys = new Map<number, string>();
  const report = await checkGrowth(growth, {
    name,
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    grow,
    warmup: async (database) => ensureSelectedReviewRestoredForWarmup(scenario, database),
    prepare: async () => prepareForMeasurement(scenario),
    operation: async (database, scale) => {
      const key = requestKey('growth-review-restore-success');
      const result = await restoreSelectedReview(scenario, database.pool, key);
      expect(result.replayed).toBe(false);
      expect(result.value.postId).toBe(scenario.original.postId);
      expect(result.value.securityRevision).toBeTruthy();
      keys.set(scale, key);
      return result;
    },
  });
  await assertGrowthReport(report);
  const key = keys.get(scales[scales.length - 1]!);
  if (!key) throw new Error(`The restore operation did not reach scale ${scales[scales.length - 1]}`);
  return key;
}

test('Successful native review restoration stays bounded as unrelated population and retained command history grow independently', async () => {
  const populationScenario = await createRestoreScenario();
  let populationGrowth: GrowthDatabase | undefined;
  try {
    await assertHiddenBeforeRestore(populationScenario);
    const initialRestoreKey = requestKey('restore-success-initial-http-restore');
    const initialRestore = await populationScenario.fixture.call(
      'POST',
      `/v1/posts/${populationScenario.original.postId}:restore`,
      { bearer: populationScenario.fixture.author.bearer, key: initialRestoreKey },
    );
    expect(initialRestore.response.status).toBe(204);
    await assertRestoredDisclosure(populationScenario);
    await prepareForMeasurement(populationScenario);

    populationGrowth = await openGrowth(populationScenario);
    const population = unrelatedReviewPopulation(populationScenario);
    const populationReplayKey = await runSuccessGrowth(
      populationScenario,
      populationGrowth,
      'Native successful review restore with growing unrelated author, subject, board and vote population',
      async (database, scale, previous) => {
        const before = await populationCounts(populationScenario, 'Unrelated restore population ');
        await seed({ pool: database.pool, admin: database.admin }, population, { from: previous, to: scale });
        const after = await populationCounts(populationScenario, 'Unrelated restore population ');
        const delta = scale - previous;
        expect(after.threads - before.threads).toBe(delta);
        expect(after.revisions - before.revisions).toBe(delta);
        expect(after.votes - before.votes).toBe(delta);
        expect(after.receipts).toBe(before.receipts);
        expect(after.outbox).toBe(before.outbox);
        expect(after.threads).toBe(scale);
        expect(after.revisions).toBe(scale);
        expect(after.votes).toBe(scale);
      },
    );
    await assertRestoredDisclosure(populationScenario);
    await assertReplayAddsNoContribution(populationScenario, populationReplayKey);
  } finally {
    await populationGrowth?.close();
    await populationScenario.fixture.close();
  }

  const historyScenario = await createRestoreScenario();
  let historyGrowth: GrowthDatabase | undefined;
  try {
    await assertHiddenBeforeRestore(historyScenario);
    const initialRestore = await historyScenario.fixture.call(
      'POST',
      `/v1/posts/${historyScenario.original.postId}:restore`,
      {
        bearer: historyScenario.fixture.author.bearer,
        key: requestKey('restore-success-history-initial-http-restore'),
      },
    );
    expect(initialRestore.response.status).toBe(204);
    await assertRestoredDisclosure(historyScenario);
    await prepareForMeasurement(historyScenario);

    const history = await createRevisionHistory(historyScenario);
    historyGrowth = await openGrowth(historyScenario);
    const historyReplayKey = await runSuccessGrowth(
      historyScenario,
      historyGrowth,
      'Native successful review restore with growing retained revision and command history',
      async (database, scale, previous) => {
        const before = await historyCounts(historyScenario, history.review.threadId);
        await growRetainedRevisionHistory(historyScenario, history, database.pool, previous, scale);
        const after = await historyCounts(historyScenario, history.review.threadId);
        const delta = scale - previous;
        expect(after.threads).toBe(before.threads);
        expect(after.votes).toBe(before.votes);
        expect(after.revisions - before.revisions).toBe(delta);
        expect(after.receipts - before.receipts).toBe(delta);
        expect(after.outbox - before.outbox).toBe(delta);
        expect(after.revisions).toBe(1 + scale);
      },
    );
    await assertRestoredDisclosure(historyScenario);
    await assertReplayAddsNoContribution(historyScenario, historyReplayKey);
  } finally {
    await historyGrowth?.close();
    await historyScenario.fixture.close();
  }
}, 600_000);
