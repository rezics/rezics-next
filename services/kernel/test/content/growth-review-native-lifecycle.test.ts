import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { revisePost, ReviewConflictError } from '../../src/content/commands.ts';
import { restorePost } from '../../src/content/restore-post.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { partitionOf, routeOf, newId } from '../../src/route/route.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';
import {
  createReviewLifecycleFixture,
  requestKey,
  type ReviewLifecycleFixture,
} from './review-native-lifecycle-fixture.ts';

const scales = [256, 1024, 4096] as const;
const body = fromPlainText('A fixed native review lifecycle growth body.');
const bodyBytes = Buffer.from(serializeDocument(body));
const bodyDigest = createHash('sha256').update(bodyBytes).digest();

type Review = Readonly<{ threadId: string; postId: string; revisionId: string }>;
type Citation = Readonly<{ questionId: string; units: number; revision: number }>;

let fixture: ReviewLifecycleFixture | undefined;
let growth: GrowthDatabase | undefined;

afterAll(async () => {
  await growth?.close();
  await fixture?.close();
});

async function vote(f: ReviewLifecycleFixture): Promise<Citation> {
  const result = await f.call('PUT', `/v1/subjects/${f.subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`, {
    bearer: f.author.bearer,
    key: requestKey('growth-review-vote'),
    body: { units: 5 },
  });
  expect(result.response.status, result.text).toBe(200);
  expect(result.value).toMatchObject({ units: 5, revision: 1 });
  return {
    questionId: STANDARD_QUESTION_ID,
    units: result.value.units as number,
    revision: result.value.revision as number,
  };
}

async function createReview(f: ReviewLifecycleFixture, title: string, citation: Citation): Promise<Review> {
  const result = await f.call('POST', '/v1/threads', {
    bearer: f.author.bearer,
    key: requestKey('growth-review-create'),
    body: {
      kind: 'review',
      title,
      body,
      licence: 'CC-BY-4.0',
      boardId: f.boardId,
      subjectIds: [f.subjectId],
      visibility: 'published',
      voteCitation: citation,
    },
  });
  expect(result.response.status, result.text).toBe(201);
  return {
    threadId: result.value.thread.id as string,
    postId: result.value.thread.firstPost.id as string,
    revisionId: result.value.thread.firstPost.revisionId as string,
  };
}

function context(label: string) {
  return {
    idempotencyKey: requestKey(label),
    deadline: Date.now() + 30_000,
    requestId: Bun.randomUUIDv7(),
  };
}

async function growthCounts(
  database: GrowthDatabase,
  input: {
    actorRoute: number;
    actorPartition: number;
    authorId: string;
    boardId: string;
    subjectId: string;
  },
) {
  const result = await database.admin.query<{
    threads: number;
    hot_threads: number;
    hot_live: number;
    revisions: number;
    hot_revisions: number;
    votes: number;
    hot_votes: number;
    receipts: number;
    outbox: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM content.thread
        WHERE route = $1 AND author_account_id = $2 AND board_id = $3 AND kind = 'review') AS threads,
       (SELECT count(*)::integer FROM content.thread
        WHERE route = $1 AND author_account_id = $2 AND board_id = $3 AND kind = 'review'
          AND review_subject_id = $4) AS hot_threads,
       (SELECT count(*)::integer FROM content.thread
        WHERE route = $1 AND author_account_id = $2 AND board_id = $3 AND kind = 'review'
          AND review_subject_id = $4 AND review_live AND availability = 'available'
          AND visibility <> 'taken_down') AS hot_live,
       (SELECT count(*)::integer FROM content.revision r JOIN content.thread t USING (route, thread_id)
        WHERE r.route = $1 AND t.author_account_id = $2 AND t.board_id = $3 AND t.kind = 'review') AS revisions,
       (SELECT count(*)::integer FROM content.revision r JOIN content.thread t USING (route, thread_id)
        WHERE r.route = $1 AND t.author_account_id = $2 AND t.board_id = $3 AND t.kind = 'review'
          AND t.review_subject_id = $4) AS hot_revisions,
       (SELECT count(*)::integer FROM rating.vote
        WHERE route = $1 AND voter_id = $2 AND question_id = $5) AS votes,
       (SELECT count(*)::integer FROM rating.vote
        WHERE route = $1 AND voter_id = $2 AND question_id = $5 AND target_id = $4) AS hot_votes,
       (SELECT count(*)::integer FROM core.receipt
        WHERE partition_no = $6 AND principal_id = $2) AS receipts,
       (SELECT count(*)::integer FROM core.outbox WHERE partition_no = $6) AS outbox`,
    [input.actorRoute, input.authorId, input.boardId, input.subjectId, STANDARD_QUESTION_ID, input.actorPartition],
  );
  return result.rows[0]!;
}

test('Joined review lifecycle retains current authority, one live slot and strict physical growth.', async () => {
  fixture = await createReviewLifecycleFixture();
  const f = fixture;
  const citation = await vote(f);
  const original = await createReview(f, 'Growth review original', citation);
  expect(
    (
      await f.call('DELETE', `/v1/posts/${original.postId}`, {
        bearer: f.author.bearer,
        key: requestKey('growth-original-delete'),
      })
    ).response.status,
  ).toBe(204);
  const replacement = await createReview(f, 'Growth review slot replacement', citation);

  const connectionString = f.system.database.pool.options.connectionString;
  if (typeof connectionString !== 'string') throw new Error('Native content pool has no connection string');
  growth = await openGrowthDatabase(connectionString);
  const database = growth;
  const actorRoute = routeOf(f.author.accountId)!;
  const actorPartition = partitionOf(actorRoute);
  const subjectRoute = routeOf(f.subjectId)!;
  const actor = f.system.actors.author.actor;
  let headRevisionId = replacement.revisionId;
  const growthRows: Population = {
    name: `review-native-lifecycle-${randomUUID()}`,
    hotPartition: actorPartition,
    hotShare: 1,
    rows: ({ ordinal }) => {
      const hotHistory = ordinal % 2 === 0;
      const targetId = hotHistory ? f.subjectId : newId(subjectRoute);
      const threadId = newId(actorRoute);
      const postId = newId(actorRoute);
      const revisionId = newId(actorRoute);
      const transactionId = newId(actorRoute);
      const live = !hotHistory;
      return {
        'content.thread': [
          {
            route: actorRoute,
            thread_id: threadId,
            author_account_id: f.author.accountId,
            board_id: f.boardId,
            title: `Seeded review history ${ordinal}`,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            first_post_id: postId,
            availability: 'available',
            kind: 'review',
            review_subject_id: targetId,
            review_live: live,
          },
        ],
        'content.post': [
          {
            route: actorRoute,
            thread_id: threadId,
            post_id: postId,
            reply_to_post_id: null,
            author_account_id: f.author.accountId,
            head_revision_id: revisionId,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            availability: live ? 'available' : 'erased',
            deleted_at: live ? null : '2026-10-30T00:00:00.000Z',
          },
        ],
        'content.revision': [
          {
            route: actorRoute,
            thread_id: threadId,
            post_id: postId,
            revision_id: revisionId,
            body: live ? bodyBytes : null,
            body_sha256: bodyDigest,
            search_text: live ? 'A fixed native review lifecycle growth body.' : null,
            licence: 'CC-BY-4.0',
            subject_ids: [targetId],
            board_id: f.boardId,
            availability: live ? 'available' : 'erased',
            recorded_transaction_id: transactionId,
            media_ids: [],
            vote_citation: null,
          },
        ],
        'rating.vote': [
          {
            route: actorRoute,
            voter_id: f.author.accountId,
            question_id: STANDARD_QUESTION_ID,
            target_id: newId(subjectRoute),
            units: ordinal % 21,
            revision: 1,
            changed_at: '2026-10-30T00:00:00.000Z',
            transaction_id: newId(actorRoute),
          },
        ],
      };
    },
  };

  const commandDependencies = (pool: GrowthDatabase['pool']) => ({
    pool,
    access: f.system.access,
    routeKey: f.system.routeKey,
  });
  const growRevisionHistory = async (pool: GrowthDatabase['pool'], from: number, to: number) => {
    for (let ordinal = from; ordinal < to; ordinal++) {
      const revised = await revisePost(
        commandDependencies(pool),
        actor,
        {
          threadId: replacement.threadId,
          itemId: replacement.postId,
          expectedRevisionId: headRevisionId,
          body,
          licence: 'CC-BY-4.0',
          subjectIds: [f.subjectId],
          boardId: f.boardId,
          voteCitation: citation,
        },
        context('growth-review-revision'),
      );
      headRevisionId = revised.value.revisionId;
    }
  };
  const refusedRestore = async (pool: GrowthDatabase['pool']) => {
    try {
      await restorePost(
        {
          pool,
          access: f.system.access,
          routeKey: f.system.routeKey,
        },
        actor,
        original.postId,
        context('growth-review-refused-restore'),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewConflictError);
      return;
    }
    throw new Error('Native restore unexpectedly took a slot held by the replacement review');
  };

  const report = await checkGrowth(database, {
    name: 'Native review restore conflict with growing author, subject, board and vote history',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    grow: async (growthDatabase, scale, previous) => {
      const before = await growthCounts(growthDatabase, {
        actorRoute,
        actorPartition,
        authorId: f.author.accountId,
        boardId: f.boardId,
        subjectId: f.subjectId,
      });
      await seed({ pool: growthDatabase.pool, admin: growthDatabase.admin }, growthRows, {
        from: previous,
        to: scale,
      });
      await growRevisionHistory(growthDatabase.pool, previous, scale);
      const after = await growthCounts(growthDatabase, {
        actorRoute,
        actorPartition,
        authorId: f.author.accountId,
        boardId: f.boardId,
        subjectId: f.subjectId,
      });
      const delta = scale - previous;
      expect(after.threads - before.threads).toBe(delta);
      expect(after.hot_threads - before.hot_threads).toBe(delta / 2);
      expect(after.hot_live).toBe(1);
      expect(after.revisions - before.revisions).toBe(delta * 2);
      expect(after.hot_revisions - before.hot_revisions).toBe(delta + delta / 2);
      expect(after.votes - before.votes).toBe(delta);
      expect(after.hot_votes).toBe(1);
      expect(after.receipts - before.receipts).toBe(delta);
      expect(after.outbox - before.outbox).toBe(delta);
      expect(after.threads).toBe(2 + scale);
      expect(after.hot_threads).toBe(2 + scale / 2);
      expect(after.revisions).toBe(2 + scale * 2);
      expect(after.hot_revisions).toBe(2 + (3 * scale) / 2);
      expect(after.votes).toBe(1 + scale);
    },
    warmup: async (growthDatabase) => refusedRestore(growthDatabase.pool),
    operation: async (growthDatabase) => refusedRestore(growthDatabase.pool),
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  for (const sample of report.samples) {
    expect(sample.repetitions).toHaveLength(1);
    expect(sample.statementRepetitions).toHaveLength(1);
    expect(sample.occurrenceRepetitions).toHaveLength(1);
    expect(sample.cost.failedStatements).toEqual({ '23505': 1 });
    expect(sample.occurrenceRepetitions[0]!.statements.filter(({ error }) => error?.code === '23505')).toHaveLength(1);
  }
  const measuredRelations = [
    ...new Set(
      report.samples.flatMap((sample) => sample.repetitions.flatMap((repetition) => Object.keys(repetition.relations))),
    ),
  ].sort();
  assertGrowthAccessPaths(report.name, report.samples, measuredRelations);
}, 180_000);
