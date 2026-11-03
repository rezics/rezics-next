import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { createThread } from '../../src/content/commands.ts';
import { softDeletePost } from '../../src/content/erase-post.ts';
import { restorePost } from '../../src/content/restore-post.ts';
import {
  createReviewDiscoveryEffect,
  processReviewDiscoveryPage,
} from '../../src/content/review-discovery-lifecycle.ts';
import { createReviewDiscoverySource } from '../../src/content/review-discovery.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';
import { standingFixture } from '../access/standing-fixture.ts';

const scales = [256, 1024, 4096] as const;
const routeKey = new Uint8Array(32).fill(73);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const body = fromPlainText('A fixed native review discovery growth body.');
const bodyBytes = Buffer.from(serializeDocument(body));
const bodyDigest = createHash('sha256').update(bodyBytes).digest();

const fixture = await standingFixture();
let growth: GrowthDatabase | undefined;
afterAll(async () => {
  await growth?.close();
  await fixture.close();
});

function requestAt(route?: number) {
  for (;;) {
    const idempotencyKey = Bun.randomUUIDv7();
    if (route === undefined || anchorRoute(routeKey, idempotencyKey) === route)
      return { idempotencyKey, requestId: Bun.randomUUIDv7(), deadline: Date.now() + 30_000 };
  }
}

async function original(pool: GrowthDatabase['pool'], outcome: { partition: number; position: bigint; epoch: number }, type: string) {
  const row = (
    await pool.query<{ id: string; type: string; subject: string | null; data: unknown; recorded_at: Date }>(
      `SELECT id,type,subject,data,recorded_at FROM core.outbox
       WHERE partition_no=$1 AND position=$2 AND epoch=$3 AND type=$4`,
      [outcome.partition, outcome.position.toString(), outcome.epoch, type],
    )
  ).rows[0]!;
  return {
    specversion: '1.0' as const,
    datacontenttype: 'application/json' as const,
    id: row.id,
    type: row.type,
    ...(row.subject === null ? {} : { subject: row.subject }),
    data: row.data,
    time: row.recorded_at.toISOString(),
    source: `urn:rezics:log:${outcome.partition}.${outcome.epoch}`,
    sequence: outcome.position.toString().padStart(19, '0'),
  };
}

async function invalidate(
  pool: GrowthDatabase['pool'],
  outcome: { partition: number; position: bigint; epoch: number },
  type: string,
) {
  const event = await original(pool, outcome, type);
  await createReviewDiscoveryEffect(pool).run(event);
  const ref = { route: outcome.partition * 16, id: event.id };
  for (let page = 0; page < 20; page++) {
    const result = await processReviewDiscoveryPage(pool, ref);
    expect(result.examined).toBeLessThanOrEqual(100);
    if (result.complete) return;
  }
  throw new Error('Review discovery growth fixture exceeded its durable bound');
}

function reviewPopulation(input: { route: number; authorId: string; boardId: string; subjectId: string }): Population {
  return {
    name: 'review-discovery-native-population',
    hotPartition: partitionOf(input.route),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const threadId = newId(input.route);
      const postId = newId(input.route);
      const revisionId = newId(input.route);
      const transactionId = newId(input.route);
      return {
        'content.thread': [
          {
            route: input.route,
            thread_id: threadId,
            author_account_id: input.authorId,
            board_id: input.boardId,
            title: `Withheld review ${ordinal}`,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            first_post_id: postId,
            availability: 'available',
            kind: 'review',
            review_subject_id: input.subjectId,
            review_live: false,
          },
        ],
        'content.post': [
          {
            route: input.route,
            thread_id: threadId,
            post_id: postId,
            reply_to_post_id: null,
            author_account_id: input.authorId,
            head_revision_id: revisionId,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            availability: 'erased',
            deleted_at: '2026-10-30T00:00:00.000Z',
          },
        ],
        'content.revision': [
          {
            route: input.route,
            thread_id: threadId,
            post_id: postId,
            revision_id: revisionId,
            body: null,
            body_sha256: bodyDigest,
            search_text: null,
            licence: 'MIT',
            subject_ids: [input.subjectId],
            board_id: input.boardId,
            availability: 'erased',
            recorded_transaction_id: transactionId,
            media_ids: [],
            vote_citation: null,
          },
        ],
      };
    },
  };
}

type PlanNode = Readonly<{ 'Node Type': string; 'Index Name'?: string; 'Actual Rows'?: number; Plans?: readonly PlanNode[] }>;
function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

test('Review discovery source versions and continued reads stay physically bounded at three native scales', async () => {
  const author = (await fixture.context()).actor;
  const board = (
    await fixture.reader.query<{ route: number; board_id: string }>(
      "SELECT route,board_id FROM content.board WHERE realm_id IS NULL AND purpose='reviews'",
    )
  ).rows[0]!;
  await fixture.grant(author.accountId, 'thread:create', { route: board.route, id: board.board_id });
  const connectionString = fixture.pool.options.connectionString;
  if (typeof connectionString !== 'string') throw new Error('Native review pool has no connection string');
  growth = await openGrowthDatabase(connectionString);
  const db = growth;
  const partition = 0x6a4;
  const liveRoute = partition * 16 + 1;
  const withheldRoute = partition * 16 + 2;
  const subjectIds: string[] = [];
  const liveReviews: Array<{ id: string; itemId: string }> = [];
  const source = createReviewDiscoverySource(
    { pool: db.pool, access: fixture.access, tokens },
    () => ({ actor: { kind: 'anonymous' }, deadline: Date.now() + 30_000 }),
  );
  async function addLiveReview(scale: number) {
    const subjectId = newId(0x6b52);
    subjectIds.push(subjectId);
    await fixture.reader.query(
      `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision)
       VALUES($1,$2,'schema:Book',$2,'visible',1)`,
      [routeOf(subjectId), subjectId],
    );
    const created = await createThread(
      { pool: db.pool, access: fixture.access, routeKey },
      author,
      {
        kind: 'review',
        title: `Current review ${scale}`,
        body,
        licence: 'MIT',
        subjectIds: [subjectId],
        boardId: board.board_id,
        visibility: 'published',
      },
      requestAt(liveRoute),
    );
    await invalidate(db.pool, created, 'com.rezics.content.thread.created.v1');
    const beforeDelete = (await source.read(partition, [created.value.threadId])).reviews[0]!;
    await fixture.grant(author.accountId, 'post:erase', {
      route: routeOf(created.value.itemId)!,
      id: created.value.itemId,
    });
    const deleted = await softDeletePost(
      { pool: db.pool, access: fixture.access, routeKey },
      author,
      { postId: created.value.itemId, reason: 'Growth lifecycle' },
      requestAt(),
    );
    await invalidate(db.pool, deleted, 'com.rezics.content.post.erased.v1');
    expect((await source.hydrate(partition, [created.value.threadId])).reviews).toEqual([]);
    const restored = await restorePost(
      { pool: db.pool, access: fixture.access, routeKey },
      author,
      created.value.itemId,
      requestAt(),
    );
    await invalidate(db.pool, restored, 'com.rezics.content.post.restored.v1');
    const current = (await source.hydrate(partition, [created.value.threadId])).reviews[0]!;
    expect(current.revisionId).toBe(beforeDelete.revisionId);
    expect(current.sourceVersion).not.toBe(beforeDelete.sourceVersion);
    liveReviews.push({ id: created.value.threadId, itemId: created.value.itemId });
  }

  const report = await checkGrowth(db, {
    name: 'Native review discovery continued current population',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    grow: async (growthDb, scale, previous) => {
      await addLiveReview(scale);
      const subjectId = subjectIds.at(-1)!;
      await seed(
        { pool: growthDb.pool, admin: growthDb.admin },
        reviewPopulation({ route: withheldRoute, authorId: author.accountId, boardId: board.board_id, subjectId }),
        { from: previous, to: scale - 1 },
      );
      const count = await growthDb.admin.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM content.thread WHERE kind='review' AND route >= $1 AND route < $2`,
        [partition * 16, (partition + 1) * 16],
      );
      expect(count.rows[0]!.count).toBe(scale);
    },
    async warmup(growthDb) {
      const trace = observeSql(growthDb.pool);
      const first = await source.pageWithCut!(partition, null, 1);
      if (first.state !== 'ready' || !first.next || first.reviews.length !== 1)
        throw new Error('Native review page did not retain a bounded continuation');
      const versions = [first.reviews[0]!.sourceVersion];
      let after: NonNullable<typeof first.next> | null = first.next;
      let sparse = false;
      for (let offset = 0; offset < liveReviews.length + 1; offset++) {
        const page = await source.pageWithCut!(partition, after, 1);
        if (page.state !== 'ready') throw new Error(`Native review continuation is ${page.state}`);
        if (page.reviews.length === 0) {
          sparse = true;
          expect(page.next).not.toBeNull();
          break;
        }
        versions.push(page.reviews[0]!.sourceVersion);
        after = page.next;
        if (after === null) break;
      }
      const current = (await source.hydrate(partition, [first.reviews[0]!.id])).reviews[0]!;
      expect(current.sourceVersion).toBe(versions[0]!);
      expect(sparse).toBe(true);
      expect(first.next.token.length).toBeLessThan(65_536);
      const candidateStatement = trace.records.find(
        ({ statement }) =>
          statement.includes("WHERE t.kind = 'review'") &&
          statement.includes('ORDER BY t.route, t.thread_id LIMIT $5'),
      );
      if (!candidateStatement) throw new Error('Native review population seek was not observed');
      const plan = await growthDb.admin.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidateStatement.statement}`,
        [...candidateStatement.parameters],
      );
      const root = plan.rows[0]!['QUERY PLAN'][0]!.Plan;
      const nodes = planNodes(root);
      expect(nodes.some((node) => node['Index Name'] === 'thread_review_discovery_population_idx')).toBe(true);
      expect(nodes.some((node) => node['Node Type'] === 'Sort')).toBe(false);
      expect(root['Actual Rows']).toBeLessThanOrEqual(5);
      await trace.close();
    },
    async operation(growthDb) {
      const trace = observeSql(growthDb.pool);
      const first = await source.pageWithCut!(partition, null, 1);
      if (first.state !== 'ready' || !first.next || first.reviews.length !== 1)
        throw new Error('Native review page did not retain a bounded continuation');
      let after: NonNullable<typeof first.next> | null = first.next;
      let pages = 1;
      let sparse = false;
      for (let offset = 0; offset < liveReviews.length + 1; offset++) {
        const page = await source.pageWithCut!(partition, after, 1);
        if (page.state !== 'ready') throw new Error(`Native review continuation is ${page.state}`);
        pages += 1;
        if (page.reviews.length === 0) {
          sparse = true;
          expect(page.next).not.toBeNull();
          break;
        }
        after = page.next;
        if (after === null) break;
      }
      const current = (await source.hydrate(partition, [first.reviews[0]!.id])).reviews[0]!;
      expect(current.sourceVersion).toBe(first.reviews[0]!.sourceVersion);
      expect(sparse).toBe(true);
      expect(pages).toBeLessThanOrEqual(5);
      expect(first.next.token.length).toBeLessThan(65_536);
      const controls = trace.records.filter(({ statement }) => /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b/i.test(statement));
      const seeks = trace.records.filter(
        ({ statement }) =>
          statement.includes("WHERE t.kind = 'review'") &&
          statement.includes('ORDER BY t.route, t.thread_id LIMIT $5'),
      );
      expect(controls.length).toBeLessThan(100);
      expect(seeks.length).toBe(pages);
      await trace.close();
    },
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  for (const sample of report.samples) {
    expect(sample.cost.rows).toBeLessThan(20_000);
    expect(sample.cost.statements).toBeLessThan(600);
    expect(sample.cost.controlStatements).toBeLessThan(100);
  }
}, 300_000);
