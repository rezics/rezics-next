import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createKernel } from '../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { CommandUnavailableError } from '../../src/command/command.ts';
import nativeTakedown from '../../src/content/takedown.sql';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  assertGrowthAccessPaths, capture, checkGrowth, costOf, openGrowthDatabase, seed,
  type GrowthDatabase, type Population,
} from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';
import {
  capturePointEvent, commandEvidence, createNativePointFixture, partitionHeads, pointPath,
  pointReason, retainedRevisions, storedTarget, targetId,
  type NativePointFixture, type PointKind, type PointTarget,
} from './moderation-native-point-fixture.ts';

// The existing README point-command check uses these scales, 64 same-home distractors per scale unit,
// series bounds and the unmodified harness defaults for warmups/repetitions.
const scales = [32, 256, 2048] as const;
const bounds = { rows: 'constant', statements: 'constant', blocks: 'logarithmic' } as const;
let fixture: NativePointFixture;
let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;

beforeAll(async () => {
  fixture = await createNativePointFixture();
  try {
    db = await openGrowthDatabase(fixture.system.database.pool.options.connectionString);
    kernel = createKernel({
      pool: db.pool, access: fixture.system.access, routeKey: fixture.system.routeKey, tokens: fixture.system.tokenKeys,
      writeRate: createWriteRateLimiter({ secret: 'native-point-growth-write-rate-secret-at-least-32-bytes', overrides: JSON.stringify({
        'new-account': { write: { maximum: 100_000, seconds: 86_400 } },
      }) }),
    });
  } catch (error) {
    try { await db?.close(); } finally { await fixture.close(); }
    throw error;
  }
}, 120_000);
afterAll(async () => {
  try { await fixture?.stopWork(); } finally {
    try { await db?.close(); } finally { await fixture?.close(); }
  }
});

async function call(path: string, bearer: string, key: string) {
  const response = await kernel.handle(new Request(`https://content.test${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key) },
    body: JSON.stringify(pointReason),
  }));
  return { status: response.status, value: await response.json() as Record<string, any> };
}

/** Noise stays on the measured board, thread and post anchors, never a cheaper container. */
async function population(target: PointTarget, kind: PointKind): Promise<Population> {
  const pool = fixture.system.database.pool;
  const board = await storedTarget(pool, 'board', target.boardId);
  const thread = await storedTarget(pool, 'thread', target.threadId);
  const post = await storedTarget(pool, 'post', target.postId);
  const revision = (await retainedRevisions(pool, target.postId))[0]!;
  return {
    name: `native-point-${kind}-same-anchor-history`, hotPartition: partitionOf(routeOf(targetId(target, kind))!), hotShare: 1,
    rows({ ordinal }) {
      const boardId = newId(target.boardRoute);
      const threadId = newId(target.threadRoute);
      const postId = newId(target.postRoute);
      const revisionId = newId(target.postRoute);
      const transaction = randomUUID();
      const at = new Date(Date.UTC(2020, 0, 1) + ordinal);
      return {
        'content.board': [{ ...board, board_id: boardId, recorded_transaction_id: transaction }],
        'content.thread': [{ ...thread, thread_id: threadId, board_id: target.boardId, first_post_id: null, recorded_transaction_id: transaction }],
        'content.post': [{ ...post, post_id: postId, thread_id: target.threadId, head_revision_id: revisionId, reply_to_post_id: target.postId, recorded_transaction_id: transaction }],
        'content.revision': [
          { ...revision, revision_id: revisionId, post_id: postId, thread_id: target.threadId, recorded_transaction_id: transaction, recorded_at: at },
          { ...revision, revision_id: newId(target.postRoute), post_id: target.postId, thread_id: target.threadId, recorded_transaction_id: transaction, recorded_at: at },
        ],
        'access.resource_grant': [{ route: target.postRoute, resource_id: postId, subject_id: fixture.moderator.actor.accountId,
          action: 'moderation:takedown', valid: '(,)', transaction_id: transaction }],
      };
    },
  };
}

for (const kind of ['board', 'thread', 'post'] as const) {
  test(`Native ${kind} point commands retain strict raw bounds as same-anchor revisions and targets grow`, async () => {
    const target = await fixture.fresh(`Growth ${kind} target`, true);
    const id = targetId(target, kind);
    await fixture.grant(id, ['moderation:takedown']);
    const noise = await population(target, kind);
    const runs: { key: string; revision: string }[] = [];
    const footprints: { scale: number; boards: number; threads: number; posts: number; revisions: number }[] = [];
    const observer = observeSql(db.pool);
    try {
      const report = await checkGrowth(db, {
        name: `Native ${kind} point command with current Auth and Access`, scales, bounds, rule: 'series',
        async grow(database, scale, previous) {
          await seed(database, noise, { from: previous * 64, to: scale * 64 });
          const counts = (await database.admin.query<{ boards: string; threads: string; posts: string; revisions: string }>(
            `SELECT (SELECT count(*) FROM content.board WHERE route=$1) AS boards,
                    (SELECT count(*) FROM content.thread WHERE route=$2 AND board_id=$3) AS threads,
                    (SELECT count(*) FROM content.post WHERE route=$2 AND thread_id=$4) AS posts,
                    (SELECT count(*) FROM content.revision WHERE route=$2 AND post_id=$5) AS revisions`,
            [target.boardRoute, target.threadRoute, target.boardId, target.threadId, target.postId],
          )).rows[0]!;
          footprints.push({ scale, boards: Number(counts.boards), threads: Number(counts.threads), posts: Number(counts.posts), revisions: Number(counts.revisions) });
        },
        async operation() {
          const key = randomUUID();
          const result = await call(pointPath(kind, id), fixture.moderator.bearer, key);
          expect(result.status).toBe(200);
          expect(result.value.securityRevision).toMatch(/^[1-9][0-9]*$/);
          runs.push({ key, revision: result.value.securityRevision });
        },
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
      for (const [index, footprint] of footprints.entries()) {
        expect(footprint.boards).toBeGreaterThanOrEqual(footprint.scale * 64);
        expect(footprint.threads).toBeGreaterThanOrEqual(footprint.scale * 64);
        expect(footprint.posts).toBeGreaterThanOrEqual(footprint.scale * 64);
        expect(footprint.revisions).toBeGreaterThanOrEqual(footprint.scale * 64);
        if (index > 0) {
          const prior = footprints[index - 1]!;
          for (const key of ['boards', 'threads', 'posts', 'revisions'] as const) expect(footprint[key]).toBeGreaterThan(prior[key]);
        }
      }
      const relations = [`content.${kind}`, 'core.receipt', 'access.resource_grant'];
      for (const sample of report.samples) {
        for (const repetition of sample.repetitions) {
          expect(repetition.rows).toBeGreaterThan(0);
          expect(repetition.blocks).toBeGreaterThan(0);
          expect(repetition.statements).toBeGreaterThan(0);
          expect(repetition.plans).toBeGreaterThan(0);
          for (const relation of relations) {
            expect(repetition.relations[relation]).toBeDefined();
            expect(sample.relationSizes[relation]).toBeDefined();
          }
          // A point command must never enumerate the growing revision history.
          expect(repetition.relations['content.revision']).toBeUndefined();
        }
      }
      assertGrowthAccessPaths(report.name, report.samples, relations);
      const writes = observer.records.filter(({ statement }) => statement === nativeTakedown.sql);
      expect(writes.length).toBeGreaterThanOrEqual(runs.length);
      for (const write of writes) {
        const args = Object.fromEntries(nativeTakedown.params.map((name, index) => [name, write.parameters[index]]));
        expect(args).toMatchObject({ route: routeOf(id), id, kind });
      }
      for (const run of runs) {
        const evidence = await commandEvidence(db.admin, fixture.moderator.actor.accountId, run.key, id);
        expect(evidence.receipts).toHaveLength(1);
        expect(evidence.receipts[0]!.partition_no).toBe(partitionOf(routeOf(id)!));
        expect(evidence.events).toHaveLength(1);
        expect(evidence.events[0]!.data).toEqual({ targetKind: kind, targetId: id, securityRevision: run.revision });
      }
      // Keep every raw metric, per-repetition footprint and native statement attribution in the handoff.
      console.info(JSON.stringify({ report, footprints, home: { kind, id, route: routeOf(id) } }));
    } finally { await observer.close(); }
  }, 300_000);
}

test('Native point replay and rollback have no extra event; genuine erasure producer work stays in its capture', async () => {
  const target = await fixture.fresh('Measured erasure producer', true);
  const control = await fixture.fresh('Measured erasure survivor');
  const canonical = await retainedRevisions(db.admin, control.postId);
  const readEvent = await capturePointEvent(db.pool, target.postId);
  const runtime = await fixture.startWork(db.pool);
  const key = randomUUID();
  const initial = await capture(db, async () => {
    const result = await call(`/v1/posts/${target.postId}:erase`, fixture.author.bearer, key);
    expect(result.status).toBe(200);
    const envelope = await readEvent();
    await runtime.produce(envelope, ['content_post_erased']);
    return result;
  }, { includeBackends: true });
  const cost = costOf(initial.capture);
  expect(cost.relations['content.post']).toBeDefined();
  expect(cost.relations['content.revision']).toBeDefined();
  expect(cost.relations['core.receipt']).toBeDefined();
  const cleaned = await retainedRevisions(db.admin, target.postId);
  expect(cleaned).toHaveLength(2);
  for (const row of cleaned) expect(row).toMatchObject({ body: null, body_sha256: null, search_text: null, availability: 'erased' });
  expect(await retainedRevisions(db.admin, control.postId)).toEqual(canonical);
  const footprint = (await db.admin.query(
    `SELECT n.nspname||'.'||c.relname AS name,c.reltuples,c.relpages,pg_relation_size(c.oid)::text AS bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('content','access','core','dbos') AND c.relkind='r'`,
  )).rows;
  console.info(JSON.stringify({ name: 'Native point erasure including actual registered producer completion', cost, raw: initial.capture, footprint }));

  const committed = await commandEvidence(db.admin, fixture.author.accountId, key, target.postId);
  expect(committed.receipts).toHaveLength(1);
  expect(committed.receipts[0]!.partition_no).toBe(partitionOf(target.postRoute));
  expect(committed.events).toHaveLength(1);
  expect(committed.events[0]!.data).toEqual({ postId: target.postId, securityRevision: initial.value.value.securityRevision });
  const noise = await population(target, 'post');
  const replayHeads = await partitionHeads(db.admin);
  const report = await checkGrowth(db, {
    name: 'Native authorized point erasure replay', scales, bounds, rule: 'series',
    async grow(database, scale, previous) {
      await seed(database, noise, { from: previous * 64, to: scale * 64 });
    },
    async operation() {
      const replay = await call(`/v1/posts/${target.postId}:erase`, fixture.author.bearer, key);
      expect(replay).toEqual(initial.value);
    },
  });
  assertGrowthAccessPaths(report.name, report.samples, ['content.post', 'core.receipt', 'access.resource_grant']);
  expect(await commandEvidence(db.admin, fixture.author.accountId, key, target.postId)).toEqual(committed);
  expect(await partitionHeads(db.admin)).toEqual(replayHeads);
  console.info(JSON.stringify(report));

  const deniedKey = randomUUID();
  const deniedHeads = await partitionHeads(db.admin);
  const denied = await capture(db, () => call(`/v1/posts/${target.postId}:erase`, fixture.other.bearer, deniedKey), { includeBackends: true });
  expect(denied.value.status).toBe(403);
  expect(denied.value.value).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
  expect(await partitionHeads(db.admin)).toEqual(deniedHeads);
  expect(await commandEvidence(db.admin, fixture.other.accountId, deniedKey, target.postId)).toEqual({ receipts: [], events: [] });

  const failure = await fixture.fresh('Rollback native target');
  await fixture.grant(failure.postId, ['moderation:takedown']);
  const observer = observeSql(db.pool);
  const before = await storedTarget(db.admin, 'post', failure.postId);
  const beforeHeads = await partitionHeads(db.admin);
  const failedKey = randomUUID();
  try {
    observer.armFault({ match: { statement: nativeTakedown.sql }, boundary: 'after',
      error: new CommandUnavailableError('deadline', partitionOf(failure.postRoute)) });
    const rollback = await capture(db, () => call(pointPath('post', failure.postId), fixture.moderator.bearer, failedKey), { includeBackends: true });
    expect(rollback.value.status).toBe(503);
    expect(rollback.value.value).toMatchObject({ code: 'deadline_exceeded', effect_status: 'not_applied' });
    expect(rollback.capture.statements.some((statement) => /^ROLLBACK/.test(statement))).toBe(true);
    expect(await storedTarget(db.admin, 'post', failure.postId)).toEqual(before);
    expect(await partitionHeads(db.admin)).toEqual(beforeHeads);
    expect(await commandEvidence(db.admin, fixture.moderator.actor.accountId, failedKey, failure.postId)).toEqual({ receipts: [], events: [] });
    console.info(JSON.stringify({ denied: { raw: denied.capture, cost: costOf(denied.capture) }, rollback: { raw: rollback.capture, cost: costOf(rollback.capture) } }));
  } finally { await observer.close(); }
}, 300_000);
