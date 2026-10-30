import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createInitiatorRestorer } from '../../src/access/durable-initiator.ts';
import { runCommand } from '../../src/command/command.ts';
import { erasePostLogicalPageAsInitiator, type ErasureInitiator } from '../../src/content/erase-post.ts';
import { readErasureInitiator } from '../../src/content/erasure-initiator.ts';
import {
  pageAuthorErasurePosts,
  nullErasedRevisionPage,
  eraseRevisionMedia,
} from '../../src/content/erasure-workflow.ts';
import { createErasureJob } from '../../src/content/erasure-job.ts';
import { partitionOf } from '../../src/route/route.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  type GrowthDatabase,
  type ReportSample,
} from '../support/growth.ts';
import {
  createAuthorErasureFixture,
  type AuthorErasureFixture,
  type NativeScope,
  type NativePost,
} from './author-erasure-native-operation-fixture.ts';

async function requested(f: AuthorErasureFixture, scope: NativeScope) {
  const result = await f.call('POST', `/v1/threads/${scope.threadId}:erase`, {
    bearer: f.author.bearer,
    key: randomUUID(),
    body: { authorId: f.author.actor.accountId },
  });
  expect(result.response.status).toBe(202);
  expect(result.value!.metadata).toEqual({
    type: 'content.author_erasure',
    threadId: scope.threadId,
    authorId: f.author.actor.accountId,
    processedPosts: 0,
    erasedRevisions: 0,
    steps: 0,
  });
  return (result.value!.name as string).slice('operations/'.length);
}

/** All population rows share the measured thread, route and partition. Each
 * unrelated body/revision is committed by its real author's ordinary API.
 */
async function growOther(f: AuthorErasureFixture, scope: NativeScope, scale: number, previous: number) {
  for (let index = previous; index < scale; index++)
    await f.reply(scope, f.other, `Other author same-thread history ${index}`);
  const rows = (
    await f.pool.query<{ posts: number; revisions: number }>(
      `SELECT count(DISTINCT p.post_id)::int AS posts,count(r.revision_id)::int AS revisions
       FROM content.post p JOIN content.revision r ON r.route=p.route AND r.post_id=p.post_id
      WHERE p.route=$1 AND p.thread_id=$2 AND p.author_account_id=$3`,
      [scope.route, scope.threadId, f.other.actor.accountId],
    )
  ).rows[0]!;
  // scope() also created one unrelated post with two real revisions.
  expect(rows).toEqual({ posts: scale + 1, revisions: scale + 2 });
}

function strictReport(name: string, samples: readonly ReportSample[], relations: string[]) {
  for (const sample of samples) {
    for (const cost of sample.repetitions) {
      expect(cost.rows).toBeGreaterThan(0);
      expect(cost.blocks).toBeGreaterThan(0);
      expect(cost.statements).toBeGreaterThan(0);
      for (const relation of relations) {
        expect(cost.relations[relation], `${name}: actual ${relation} capture`).toBeDefined();
        expect(sample.relationSizes[relation], `${name}: actual ${relation} footprint`).toBeDefined();
        expect(sample.relationSizes[relation]!.relpages).toBeGreaterThanOrEqual(0);
      }
    }
  }
  assertGrowthAccessPaths(name, samples, relations);
  // Preserve the harness's entire raw cost, repetitions and actual relation sizes.
  console.info(name, JSON.stringify(samples));
}

function nativeInitiator(
  f: AuthorErasureFixture,
  db: GrowthDatabase,
  scope: NativeScope,
  operationId: string,
): ErasureInitiator {
  const actor = f.author.actor;
  return {
    kind: 'durable-initiator',
    operation: { route: scope.route, id: operationId, kind: 'content.author-erasure', sourceId: operationId },
    accountId: actor.accountId,
    clientId: actor.clientId,
    requestedBy: actor.requestedBy,
    restorer: createInitiatorRestorer({
      pool: db.pool,
      access: f.system.access,
      readOperation: async (client, operation, time) => {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const record = await readErasureInitiator(client, operation, time);
          await client.query('COMMIT');
          return record;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      },
      readConsent: ({ actorAccountId, clientId }) => f.consent.readCurrentConsent({ actorAccountId, clientId }),
    }),
  };
}

test('Original documented privacy, replay and raw growth bounds remain strict', async () => {
  const f = await createAuthorErasureFixture();
  let db: GrowthDatabase | undefined;
  try {
    db = await openGrowthDatabase(f.pool.options.connectionString!);
    const measured = db;
    const scope = await f.scope(1, 1);
    const actor = f.author.actor;
    let prepared: { posts: NativePost[]; initiator: ErasureInitiator; key: string; operationId: string } | undefined;
    const runs: { ids: string[]; operationId: string; key: string }[] = [];
    async function preparePage() {
      const posts: NativePost[] = [];
      for (let index = 0; index < 100; index++) {
        const post = await f.reply(scope, f.author, `Affected author page ${index}`);
        await f.revise(post, `Affected historical revision one ${index}`);
        await f.revise(post, `Affected historical revision two ${index}`);
        posts.push(post);
      }
      const operationId = await requested(f, scope);
      prepared = {
        posts,
        operationId,
        key: randomUUID(),
        // Restoration consumes the native HTTP operation's original receipt.
        initiator: nativeInitiator(f, measured, scope, operationId),
      };
    }
    async function operation() {
      if (!prepared) throw new Error('Native author page was not prepared');
      const page = prepared;
      const result = await erasePostLogicalPageAsInitiator(
        { pool: measured.pool, access: f.system.access },
        page.initiator,
        {
          threadId: scope.threadId,
          postIds: page.posts.map(({ id }) => id),
          reason: 'Author erasure',
        },
        { idempotencyKey: page.key, requestId: page.operationId, deadline: Date.now() + 10_000 },
      );
      expect(result.replayed).toBe(false);
      expect(result.value).toEqual({
        postIds: page.posts.map(({ id }) => id),
        processedPosts: 100,
        erasedRevisions: 300,
      });
      runs.push({ ids: result.value.postIds, operationId: page.operationId, key: page.key });
    }
    const report = await checkGrowth(measured, {
      name: 'native logical author page',
      rule: 'series',
      scales: [256, 1024, 4096],
      repetitions: 1,
      // Existing erasure-workflow derivation: operation source/restoration, seek
      // and anchor; 100 validations/counts/tombstones and native Access P/Q.
      indexProbes: 2 + 1 + 1 + 100 * (1 + 1 + 1 + 5) + 7 + 3,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: (_db, scale, previous) => growOther(f, scope, scale, previous),
      async warmup() {
        await preparePage();
        await operation();
      },
      prepare: preparePage,
      operation,
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
    strictReport('Native author page raw growth', report.samples, [
      'content.post',
      'content.revision',
      'content.operation',
      'core.receipt',
      'access.account',
    ]);
    for (const run of runs) {
      const rows = await f.pool.query<{ post_id: string; availability: string }>(
        'SELECT post_id,availability FROM content.post WHERE route=$1 AND post_id=ANY($2::uuid[]) ORDER BY post_id',
        [scope.route, run.ids],
      );
      expect(rows.rows).toHaveLength(100);
      expect(rows.rows.every(({ availability }) => availability === 'erased')).toBe(true);
      const receipt = await f.pool.query(
        `SELECT response FROM core.receipt WHERE partition_no=$1 AND principal_id=$2 AND idempotency_key=$3
         AND command_kind='content.author-erasure.page'`,
        [partitionOf(scope.route), actor.accountId, run.key],
      );
      expect(receipt.rows).toHaveLength(1);
      const events = await f.pool.query(
        `SELECT subject FROM core.outbox WHERE partition_no=$1 AND type='com.rezics.content.post.erased.v1'
         AND subject=ANY($2::text[])`,
        [partitionOf(scope.route), run.ids],
      );
      expect(events.rows).toHaveLength(100);
    }
  } finally {
    try {
      await db?.close();
    } finally {
      await f.close();
    }
  }
}, 240_000);

test('Original documented privacy, replay and raw growth bounds remain strict: native revision and media pages', async () => {
  const f = await createAuthorErasureFixture();
  let db: GrowthDatabase | undefined;
  try {
    const scope = await f.scope(1, 1);
    db = await openGrowthDatabase(f.pool.options.connectionString!);
    const measured = db;
    type CleanupPage = {
      post: NativePost;
      mediaId: string;
      operationId: string;
      revisions: string[];
      after: { at: string; id: string };
      upper: { at: string; id: string };
    };
    let prepared: CleanupPage | undefined;
    const completed: CleanupPage[] = [];
    async function preparePage() {
      const after = (
        await f.pool.query<{ at: string; id: string }>(
          `SELECT created_at::text AS at,post_id AS id FROM content.post
         WHERE route=$1 AND thread_id=$2 AND author_account_id=$3 ORDER BY created_at DESC,post_id DESC LIMIT 1`,
          [scope.route, scope.threadId, f.author.actor.accountId],
        )
      ).rows[0]!;
      const post = await f.reply(scope, f.author, 'Affected physical cleanup page');
      for (let index = 1; index < 100; index++) await f.revise(post, `Affected revision ${index}`);
      const mediaId = await f.claimMedia(scope, post);
      const operationId = await requested(f, scope);
      const result = await erasePostLogicalPageAsInitiator(
        { pool: f.pool, access: f.system.access },
        nativeInitiator(f, measured, scope, operationId),
        {
          threadId: scope.threadId,
          postIds: [post.id],
          reason: 'Author erasure',
        },
        {
          idempotencyKey: `wf:${operationId}:erase:${after.at}:${after.id}`,
          requestId: operationId,
          deadline: Date.now() + 10_000,
        },
      );
      expect(result.replayed).toBe(false);
      expect(result.value).toEqual({ postIds: [post.id], processedPosts: 1, erasedRevisions: 101 });
      const upper = (
        await f.pool.query<{ at: string; id: string }>(
          'SELECT upper_created_at::text AS at,upper_post_id AS id FROM content.operation WHERE route=$1 AND operation_id=$2',
          [scope.route, operationId],
        )
      ).rows[0]!;
      const revisions = (
        await f.pool.query<{ revision_id: string }>(
          'SELECT revision_id FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY recorded_at,revision_id',
          [scope.route, post.id],
        )
      ).rows.map(({ revision_id }) => revision_id);
      expect(revisions).toHaveLength(101);
      prepared = { post, mediaId, operationId, revisions, after, upper };
    }
    async function operation(target: GrowthDatabase) {
      if (!prepared) throw new Error('Native physical cleanup page was not prepared');
      const page = prepared;
      await runCommand(target.pool, { partition: partitionOf(scope.route) }, async (tx) => {
        const posts = await pageAuthorErasurePosts(tx, {
          route: scope.route,
          partition_no: partitionOf(scope.route),
          operation_id: page.operationId,
          initiator_id: f.author.actor.accountId,
          author_id: f.author.actor.accountId,
          thread_id: scope.threadId,
          after_at: page.after.at,
          after_id: page.after.id,
          upper_at: page.upper.at,
          upper_id: page.upper.id,
        });
        expect(posts.map(({ post_id }) => post_id)).toEqual([page.post.id]);
        expect(posts[0]!.committed).toBe(true);
        const revisions = await nullErasedRevisionPage(tx, {
          route: scope.route,
          post_id: page.post.id,
          after_at: '-infinity',
          after_id: page.post.id,
        });
        expect(revisions.map(({ revision_id }) => revision_id)).toEqual(page.revisions.slice(0, 100));
        expect(revisions.every(({ changed }) => changed)).toBe(true);
        const media = await eraseRevisionMedia(tx, {
          route: scope.route,
          post_id: page.post.id,
          revision_id: page.revisions.at(-1)!,
        });
        expect(media).toEqual([{ media_id: page.mediaId, container_id: scope.threadId, changed: true }]);
        return { value: null, events: [] };
      });
      // The irreversible media decision also requires its actual producer purge,
      // after the partition command releases its connection, inside the capture.
      expect(await createErasureJob(target.pool, f.objects.storage).purgeObject(page.mediaId)).toEqual({
        mediaId: page.mediaId,
        outcome: 'purged',
      });
      completed.push(page);
    }
    const report = await checkGrowth(measured, {
      name: 'native content erasure pages',
      scales: [32, 256, 2048],
      warmups: 1,
      repetitions: 5,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: (_db, scale, previous) => growOther(f, scope, scale, previous),
      async warmup(target) {
        await preparePage();
        await operation(target);
      },
      prepare: preparePage,
      operation,
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([32, 256, 2048]);
    strictReport('Native revision and media raw growth', report.samples, [
      'content.post',
      'content.revision',
      'content.media',
      'core.receipt',
    ]);
    for (const page of completed) {
      const erased = await f.pool.query(
        `SELECT body,body_sha256,search_text,availability FROM content.revision
         WHERE route=$1 AND post_id=$2 ORDER BY recorded_at,revision_id`,
        [scope.route, page.post.id],
      );
      expect(erased.rows).toHaveLength(101);
      expect(
        erased.rows
          .slice(0, 100)
          .every(
            (row) =>
              row.body === null &&
              row.body_sha256 === null &&
              row.search_text === null &&
              row.availability === 'erased',
          ),
      ).toBe(true);
      expect(erased.rows[100]).toMatchObject({ availability: 'available', body: expect.any(Buffer) });
      expect(f.objects.inspect().filter(({ key }) => key.startsWith(`m/${page.mediaId}/`))).toEqual([]);
    }
  } finally {
    try {
      await db?.close();
    } finally {
      await f.close();
    }
  }
}, 240_000);
