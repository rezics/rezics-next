import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createInitiatorRestorer } from '../../src/access/durable-initiator.ts';
import { runCommand } from '../../src/command/command.ts';
import { erasePostLogicalPageAsInitiator, type ErasureInitiator } from '../../src/content/erase-post.ts';
import { readErasureInitiator } from '../../src/content/erasure-initiator.ts';
import { pageAuthorErasurePosts, nullErasedRevisionPage, eraseRevisionMedia } from '../../src/content/erasure-workflow.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import {
  assertGrowthAccessPaths, checkGrowth, openGrowthDatabase, type GrowthDatabase, type ReportSample,
} from '../support/growth.ts';
import {
  createAuthorErasureFixture, type AuthorErasureFixture, type NativeScope, type NativePost,
} from './author-erasure-native-operation-fixture.ts';

async function requested(f: AuthorErasureFixture, scope: NativeScope) {
  const result = await f.call('POST', `/v1/threads/${scope.threadId}:erase`, {
    bearer: f.author.bearer, key: randomUUID(), body: { authorId: f.author.actor.accountId },
  });
  expect(result.response.status).toBe(202);
  expect(result.value!.metadata).toEqual({
    type: 'content.author_erasure', threadId: scope.threadId, authorId: f.author.actor.accountId,
    processedPosts: 0, erasedRevisions: 0, steps: 0,
  });
  return (result.value!.name as string).slice('operations/'.length);
}

/** All population rows share the measured thread, route and partition. Each
 * unrelated body/revision is committed by its real author's ordinary API.
 */
async function growOther(f: AuthorErasureFixture, scope: NativeScope, scale: number, previous: number) {
  for (let index = previous; index < scale; index++)
    await f.reply(scope, f.other, `Other author same-thread history ${index}`);
  const rows = (await f.pool.query<{ posts: number; revisions: number }>(
    `SELECT count(DISTINCT p.post_id)::int AS posts,count(r.revision_id)::int AS revisions
       FROM content.post p JOIN content.revision r ON r.route=p.route AND r.post_id=p.post_id
      WHERE p.route=$1 AND p.thread_id=$2 AND p.author_account_id=$3`,
    [scope.route, scope.threadId, f.other.actor.accountId],
  )).rows[0]!;
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

test('Original documented privacy, replay and raw growth bounds remain strict: native 100-post author page', async () => {
  const f = await createAuthorErasureFixture();
  let db: GrowthDatabase | undefined;
  try {
    db = await openGrowthDatabase(f.pool.options.connectionString!);
    const measured = db;
    const scope = await f.scope(1, 1);
    const actor = f.author.actor;
    // Restoration consumes the native HTTP operation's original creation
    // receipt. Neither an actor JSON snapshot nor a new identity supplies proof.
    const restorer = createInitiatorRestorer({
      pool: measured.pool, access: f.system.access,
      readOperation: async (client, operation, time) => {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const record = await readErasureInitiator(client, operation, time);
          await client.query('COMMIT');
          return record;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
      },
      readConsent: ({ actorAccountId, clientId }) => f.consent.readCurrentConsent({ actorAccountId, clientId }),
    });
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
        posts, operationId, key: randomUUID(),
        initiator: {
          kind: 'durable-initiator', operation: { route: scope.route, id: operationId, kind: 'content.author-erasure', sourceId: operationId },
          accountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy, restorer,
        },
      };
    }
    async function operation() {
      if (!prepared) throw new Error('Native author page was not prepared');
      const page = prepared;
      const result = await erasePostLogicalPageAsInitiator({ pool: measured.pool, access: f.system.access }, page.initiator, {
        threadId: scope.threadId, postIds: page.posts.map(({ id }) => id), reason: 'Author erasure',
      }, { idempotencyKey: page.key, requestId: page.operationId, deadline: Date.now() + 10_000 });
      expect(result.replayed).toBe(false);
      expect(result.value).toEqual({ postIds: page.posts.map(({ id }) => id), processedPosts: 100, erasedRevisions: 300 });
      runs.push({ ids: result.value.postIds, operationId: page.operationId, key: page.key });
    }
    const report = await checkGrowth(measured, {
      name: 'native logical author page', rule: 'series', scales: [256, 1024, 4096], repetitions: 1,
      // Existing erasure-workflow derivation: operation source/restoration, seek
      // and anchor; 100 validations/counts/tombstones and native Access P/Q.
      indexProbes: 2 + 1 + 1 + 100 * (1 + 1 + 1 + 5) + 7 + 3,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: (_db, scale, previous) => growOther(f, scope, scale, previous),
      async warmup() { await preparePage(); await operation(); },
      prepare: preparePage,
      operation,
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
    strictReport('Native author page raw growth', report.samples, [
      'content.post', 'content.revision', 'content.operation', 'core.receipt', 'access.account',
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
         AND command_kind='content.author-erasure.page'`, [partitionOf(scope.route), actor.accountId, run.key],
      );
      expect(receipt.rows).toHaveLength(1);
      const events = await f.pool.query(
        `SELECT subject FROM core.outbox WHERE partition_no=$1 AND type='com.rezics.content.post.erased.v1'
         AND subject=ANY($2::text[])`, [partitionOf(scope.route), run.ids],
      );
      expect(events.rows).toHaveLength(100);
    }
  } finally { try { await db?.close(); } finally { await f.close(); } }
}, 240_000);

test('Original documented privacy, replay and raw growth bounds remain strict: native revision and media pages', async () => {
  const f = await createAuthorErasureFixture();
  let db: GrowthDatabase | undefined;
  try {
    const scope = await f.scope(1, 100, true);
    const operationId = await requested(f, scope);
    await f.startWorker();
    const deadline = Date.now() + 120_000;
    let workflowId: string | undefined;
    while (!workflowId) {
      workflowId = (await f.pool.query<{ native_workflow_id: string | null }>(
        'SELECT native_workflow_id FROM content.operation WHERE route=$1 AND operation_id=$2', [scope.route, operationId],
      )).rows[0]?.native_workflow_id ?? undefined;
      if (!workflowId && Date.now() >= deadline) throw new Error('Native cleanup operation was not bound');
      if (!workflowId) await Bun.sleep(10);
    }
    expect(await f.client.retrieveWorkflow(workflowId).getResult({ pollingIntervalMs: 10 })).toEqual({ processedPosts: 1, erasedRevisions: 101 });
    await f.stopWorker();
    db = await openGrowthDatabase(f.pool.options.connectionString!);
    const source = (await f.pool.query<{ upper_at: string; upper_id: string }>(
      'SELECT upper_created_at::text AS upper_at,upper_post_id AS upper_id FROM content.operation WHERE route=$1 AND operation_id=$2',
      [scope.route, operationId],
    )).rows[0]!;
    const identities = (await f.pool.query<{ revision_id: string }>(
      'SELECT revision_id FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY recorded_at,revision_id',
      [scope.route, scope.posts[0]!.id],
    )).rows.map(({ revision_id }) => revision_id);
    expect(identities).toHaveLength(101);
    const report = await checkGrowth(db, {
      name: 'native content erasure pages', scales: [32, 256, 2048], warmups: 1, repetitions: 5,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: (_db, scale, previous) => growOther(f, scope, scale, previous),
      async operation(target) {
        await runCommand(target.pool, { partition: partitionOf(scope.route) }, async (tx) => {
          const posts = await pageAuthorErasurePosts(tx, {
            route: scope.route, partition_no: partitionOf(scope.route), operation_id: operationId,
            initiator_id: f.author.actor.accountId, author_id: f.author.actor.accountId, thread_id: scope.threadId,
            after_at: '-infinity', after_id: operationId, upper_at: source.upper_at, upper_id: source.upper_id,
          });
          expect(posts.map(({ post_id }) => post_id)).toEqual([scope.posts[0]!.id]);
          expect(posts[0]!.committed).toBe(true);
          const revisions = await nullErasedRevisionPage(tx, {
            route: scope.route, post_id: scope.posts[0]!.id, after_at: '-infinity', after_id: scope.posts[0]!.id,
          });
          expect(revisions.map(({ revision_id }) => revision_id)).toEqual(identities.slice(0, 100));
          expect(revisions.every(({ changed }) => !changed)).toBe(true);
          const media = await eraseRevisionMedia(tx, {
            route: scope.route, post_id: scope.posts[0]!.id, revision_id: identities.at(-1)!,
          });
          expect(media).toEqual([{ media_id: scope.mediaId!, container_id: scope.threadId, changed: false }]);
          return { value: null, events: [] };
        });
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([32, 256, 2048]);
    strictReport('Native revision and media raw growth', report.samples, ['content.post', 'content.revision', 'content.media', 'core.receipt']);
    const erased = await f.pool.query(
      'SELECT body,body_sha256,search_text,availability FROM content.revision WHERE route=$1 AND post_id=$2',
      [routeOf(scope.posts[0]!.id), scope.posts[0]!.id],
    );
    expect(erased.rows).toHaveLength(101);
    expect(erased.rows.every((row) => row.body === null && row.body_sha256 === null && row.search_text === null && row.availability === 'erased')).toBe(true);
    expect(f.objects.inspect().filter(({ key }) => key.startsWith(`m/${scope.mediaId}/`))).toEqual([]);
  } finally { try { await db?.close(); } finally { await f.close(); } }
}, 240_000);
