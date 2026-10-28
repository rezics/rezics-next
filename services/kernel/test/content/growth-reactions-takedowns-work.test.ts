import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import { checkGrowth, GrowthBoundError, seed, type GrowthReport, type Population } from '../support/growth.ts';
import { reactionFixture, request } from './reactions.test.ts';
import { clearReaction } from '../../src/content/reactions.ts';
import { liftTakedown } from '../../src/content/lift-takedown.ts';
import { principalCommandIdentity, runCommand, type CommandEvent } from '../../src/command/command.ts';
import { durableInitiatorCommitment } from '../../src/access/durable-initiator-capture.ts';
import type { DurableInitiatorRecord } from '../../src/access/durable-initiator.ts';
import { contentEffects } from '../../src/content/relays.ts';
import { createContentOperationClient, createContentWork } from '../../src/content/work.ts';
import { createContentWorkAccess } from '../../src/content/register.ts';
import type { WorkModule } from '../../src/work/registry.ts';
import { composeWork } from '../../src/work/registry.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { CONTENT_WORKFLOWS, contentWorkWorkflowId, type ContentWorkSource } from '../../src/content/work-contract.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import type { AccountActor } from '../../src/request/access.ts';

const scales = [64, 512, 4096] as const;
const populationMultiplier = 4;
const historyPositionStride = 50_000;
const boardRoute = 0x5231;
const reactionBody = Buffer.from('growth reaction target');
const reactionBodyHash = createHash('sha256').update(reactionBody).digest();
const workRoute = 0x4231;
const workPartition = partitionOf(workRoute);
const routeKey = new Uint8Array(32).fill(7);
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
let nextHistoryPosition = 10_000_000_000;

let fixture: Awaited<ReturnType<typeof reactionFixture>>;
let actor: Awaited<ReturnType<typeof fixture.verified>>;
let workClient: WorkClient | undefined;
let workRuntime: Awaited<ReturnType<typeof composeWork>> | undefined;
let operationClient: ReturnType<typeof createContentOperationClient> | undefined;
let effects: ReturnType<typeof contentEffects> = [];
let workActor: AccountActor;
let mediaBytes: Uint8Array;
let originalFetch: typeof globalThis.fetch;
const mediaObjects = new Map<string, Uint8Array>();
type DiagnosticContext = Readonly<{
  name: string;
  phase: 'warmup' | 'operation';
  scale: number;
  repetition: number;
}>;
type DiagnosticPlan = DiagnosticContext & Readonly<{ sql: string; plan: unknown }>;
let diagnosticContext: DiagnosticContext | undefined;
const diagnosticPlans: DiagnosticPlan[] = [];

function observePlans(pool: Pool): void {
  const observed = new WeakSet<PoolClient>();
  const attach = (client: PoolClient) => {
    if (observed.has(client)) return;
    observed.add(client);
    client.on('notice', (notice) => {
      const message = notice.message;
      const marker = 'plan:\n';
      if (
        typeof message !== 'string' ||
        !diagnosticContext ||
        !message.startsWith('duration:') ||
        !message.includes(marker)
      )
        return;
      try {
        const document = JSON.parse(message.slice(message.indexOf(marker) + marker.length)) as unknown;
        const roots = Array.isArray(document) ? document : [document];
        for (const root of roots) {
          if (typeof root !== 'object' || root === null || !('Plan' in root) || !('Query Text' in root)) continue;
          const record = root as { Plan: unknown; 'Query Text': unknown };
          if (typeof record['Query Text'] !== 'string') continue;
          diagnosticPlans.push({ ...diagnosticContext, sql: record['Query Text'], plan: record.Plan });
        }
      } catch {
        // The growth harness also parses auto_explain notices and reports malformed plans.
      }
    });
  };
  pool.on('connect', attach);
  pool.on('acquire', attach);
}

async function diagnose<T>(context: DiagnosticContext, operation: () => Promise<T>): Promise<T> {
  const previous = diagnosticContext;
  diagnosticContext = context;
  try {
    return await operation();
  } finally {
    diagnosticContext = previous;
  }
}

function planRows(plan: unknown): number {
  if (typeof plan !== 'object' || plan === null) return 0;
  const row = plan as Record<string, unknown>;
  const nodeType = row['Node Type'];
  const isScan =
    nodeType === 'Seq Scan' ||
    nodeType === 'Index Scan' ||
    nodeType === 'Index Only Scan' ||
    nodeType === 'Bitmap Heap Scan' ||
    nodeType === 'Tid Scan' ||
    nodeType === 'Tid Range Scan' ||
    nodeType === 'Sample Scan';
  const actual = typeof row['Actual Rows'] === 'number' ? row['Actual Rows'] : 0;
  const filtered = typeof row['Rows Removed by Filter'] === 'number' ? row['Rows Removed by Filter'] : 0;
  const rechecked = typeof row['Rows Removed by Index Recheck'] === 'number' ? row['Rows Removed by Index Recheck'] : 0;
  const loops = typeof row['Actual Loops'] === 'number' ? row['Actual Loops'] : 1;
  const children = Array.isArray(row.Plans) ? row.Plans.reduce((sum, child) => sum + planRows(child), 0) : 0;
  return children + (isScan ? (actual + filtered + rechecked) * loops : 0);
}

function planBlocks(plan: unknown): number {
  if (typeof plan !== 'object' || plan === null) return 0;
  const row = plan as Record<string, unknown>;
  const hit = typeof row['Shared Hit Blocks'] === 'number' ? row['Shared Hit Blocks'] : 0;
  const read = typeof row['Shared Read Blocks'] === 'number' ? row['Shared Read Blocks'] : 0;
  const children = Array.isArray(row.Plans) ? row.Plans.reduce((sum, child) => sum + planBlocks(child), 0) : 0;
  return Math.max(0, hit + read - children);
}

function planRelations(plan: unknown, names = new Set<string>()): Set<string> {
  if (typeof plan !== 'object' || plan === null) return names;
  const row = plan as Record<string, unknown>;
  if (typeof row['Relation Name'] === 'string')
    names.add(`${typeof row.Schema === 'string' ? row.Schema : ''}.${row['Relation Name']}`.replace(/^\./, ''));
  if (Array.isArray(row.Plans)) for (const child of row.Plans) planRelations(child, names);
  return names;
}

function printBoundEvidence(name: string, error: GrowthBoundError): void {
  const relations = new Set(error.samples.flatMap(({ cost }) => Object.keys(cost.relations ?? {})));
  const metric = error.violations[0]?.metric ?? 'rows';
  const relation = [...relations]
    .map((candidate) => {
      const values = error.samples.map(
        ({ cost }) => cost.relations?.[candidate]?.[metric === 'blocks' ? 'blocks' : 'rows'] ?? 0,
      );
      return { name: candidate, growth: Math.max(...values) - Math.min(...values) };
    })
    .sort((left, right) => right.growth - left.growth)[0]?.name;
  const operationPlans = diagnosticPlans.filter(
    ({ name: candidate, phase }) => candidate === name && phase === 'operation',
  );
  const perScale = new Map<number, Map<string, DiagnosticPlan>>();
  for (const item of operationPlans) {
    const statements = perScale.get(item.scale) ?? new Map<string, DiagnosticPlan>();
    const existing = statements.get(item.sql);
    if (!existing || item.repetition < existing.repetition) statements.set(item.sql, item);
    perScale.set(item.scale, statements);
  }
  const sqlCandidates = new Set([...perScale.values()].flatMap((statements) => [...statements.keys()]));
  const selectedSql = [...sqlCandidates]
    .map((sql) => {
      const entries = error.samples.flatMap(({ scale }) => {
        const item = perScale.get(scale)?.get(sql);
        return item ? [{ scale, item }] : [];
      });
      const plans = entries.map(({ item }) => item.plan);
      const cost = (plan: unknown) => (metric === 'blocks' ? planBlocks(plan) : planRows(plan));
      const values = plans.map(cost);
      const growsWithRelation = relation ? plans.some((plan) => planRelations(plan).has(relation)) : false;
      return { sql, entries, growth: Math.max(0, ...values) - Math.min(...values), growsWithRelation };
    })
    .sort(
      (left, right) => Number(right.growsWithRelation) - Number(left.growsWithRelation) || right.growth - left.growth,
    )[0];
  console.error(
    'GROWTH_EVIDENCE',
    JSON.stringify({
      name,
      message: error.message,
      relation,
      series: error.samples.map(({ scale, cost }) => ({
        scale,
        rows: cost.rows,
        blocks: cost.blocks,
        statements: cost.statements,
        relationCost: relation ? cost.relations?.[relation] : undefined,
      })),
      statement: selectedSql
        ? {
            sql: selectedSql.sql,
            plans: selectedSql.entries.map(({ scale, item }) => ({ scale, plan: item.plan })),
          }
        : undefined,
    }),
  );
}

async function collectGrowth(
  name: string,
  failures: GrowthBoundError[],
  run: () => Promise<GrowthReport>,
): Promise<GrowthReport | undefined> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof GrowthBoundError)) throw error;
    printBoundEvidence(name, error);
    failures.push(error);
    return undefined;
  }
}

function throwGrowthFailures(failures: readonly GrowthBoundError[]): void {
  if (failures.length > 0) throw failures[0];
}

const context = () => ({
  deadline: Date.now() + 30_000,
  idempotencyKey: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
});

beforeAll(async () => {
  fixture = await reactionFixture();
  observePlans(fixture.db.pool);
  fixture.db.pool.options.max = 1;
  actor = await fixture.verified();
  workActor = { ...actor, scopes: [...new Set([...actor.scopes, 'post:erase'])] };
  mediaBytes = new Uint8Array(
    await sharp({ create: { width: 48, height: 32, channels: 3, background: '#4477cc' } })
      .png()
      .toBuffer(),
  );
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === 'images.example.org')
      return new Response(mediaBytes.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(mediaBytes.byteLength) },
      });
    return originalFetch(request);
  }) as typeof globalThis.fetch;

  const contentPool = fixture.db.openPool({ max: 4 });
  const clientPool = fixture.db.openPool({ max: 4 });
  observePlans(contentPool);
  observePlans(clientPool);
  workClient = await createWorkClient(fixture.db.url, clientPool);
  const storage: MediaStorage = {
    async get(key) {
      return mediaObjects.get(key) ?? null;
    },
    async put(key, bytes) {
      mediaObjects.set(key, new Uint8Array(bytes));
    },
    async deletePrefix(prefix) {
      for (const key of mediaObjects.keys()) if (key.startsWith(prefix)) mediaObjects.delete(key);
    },
  };
  const module: WorkModule = {
    name: 'content',
    async register(workContext) {
      await createContentWork({
        storage,
        access: createContentWorkAccess(workContext.clock),
        readConsent: async ({ actorAccountId, clientId }) => ({
          actorAccountId,
          clientId,
          scopes: workActor.scopes,
        }),
        routeKey,
        fetchConfig: { allowedHosts: ['images.example.org'] },
        collectionPartitions: [workPartition],
      }).register(workContext);
      workContext.addEffects(contentEffects(workContext.pool, workContext.client));
    },
  };
  workRuntime = await composeWork([module], {
    databaseUrl: fixture.db.url,
    executorId: `growth-content-work-${crypto.randomUUID()}`,
    pool: contentPool,
    client: workClient,
  });
  effects = contentEffects(contentPool, workClient);
  operationClient = createContentOperationClient({ pool: contentPool, client: workClient, clock: () => new Date() });
  await workRuntime.launch();
}, 120_000);

afterAll(async () => {
  try {
    await workRuntime?.shutdown();
  } finally {
    await workClient?.close();
    if (originalFetch) globalThis.fetch = originalFetch;
    await fixture?.close();
  }
});

async function makeReactionKeys(): Promise<{
  readonly threadId: string;
  readonly postId: string;
  readonly subjectId: string;
}> {
  const db = fixture.db;
  const boardId = newId(boardRoute);
  const threadId = newId(fixture.targetRoute);
  const rootPostId = newId(fixture.targetRoute);
  const rootRevisionId = newId(fixture.targetRoute);
  const postIds = [rootPostId, ...Array.from({ length: 32 }, () => newId(fixture.targetRoute))];
  const revisionIds = [rootRevisionId, ...Array.from({ length: 32 }, () => newId(fixture.targetRoute))];
  const postRows = postIds.map((postId, index) => ({
    route: fixture.targetRoute,
    thread_id: threadId,
    post_id: postId,
    reply_to_post_id: index === 0 ? null : postIds[index - 1],
    author_account_id: fixture.managerId,
    head_revision_id: revisionIds[index],
    visibility: 'published',
    security_revision: 1,
    recorded_transaction_id: fixture.managerId,
  }));
  const revisionRows = revisionIds.map((revisionId, index) => ({
    route: fixture.targetRoute,
    thread_id: threadId,
    post_id: postIds[index],
    revision_id: revisionId,
    body: reactionBody.toString('base64'),
    licence: 'CC0-1.0',
    subject_ids: [],
    board_id: boardId,
    availability: 'available',
    recorded_transaction_id: fixture.managerId,
  }));
  const content = await db.admin.connect();
  try {
    await content.query('BEGIN');
    await content.query(
      `INSERT INTO content.board
         (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,'Reaction growth','published',1,$4)`,
      [boardRoute, boardId, newId(boardRoute), fixture.managerId],
    );
    await content.query(
      `INSERT INTO content.thread
         (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id)
       VALUES ($1,$2,$3,$4,'Reaction growth','published',1,$3,$5)`,
      [fixture.targetRoute, threadId, fixture.managerId, boardId, rootPostId],
    );
    await content.query(
      `INSERT INTO content.post
         (route,thread_id,post_id,reply_to_post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
       SELECT route,thread_id,post_id,reply_to_post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id
       FROM jsonb_to_recordset($1::jsonb) AS x(
         route integer,thread_id uuid,post_id uuid,reply_to_post_id uuid,author_account_id uuid,
         head_revision_id uuid,visibility text,security_revision integer,recorded_transaction_id uuid
       )`,
      [JSON.stringify(postRows)],
    );
    await content.query(
      `INSERT INTO content.revision
         (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
       SELECT route,thread_id,post_id,revision_id,decode(body,'base64'),sha256(decode(body,'base64')),'growth',licence,subject_ids,board_id,availability,recorded_transaction_id
       FROM jsonb_to_recordset($1::jsonb) AS x(
         route integer,thread_id uuid,post_id uuid,revision_id uuid,body text,licence text,subject_ids uuid[],board_id uuid,
         availability text,recorded_transaction_id uuid
       )`,
      [JSON.stringify(revisionRows)],
    );
    await content.query('COMMIT');
  } catch (error) {
    await content.query('ROLLBACK');
    throw error;
  } finally {
    content.release();
  }
  const postId = postIds.at(-1)!;
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,'reaction:set','(,)',$3),($1,$4,$3,'reaction:set','(,)',$3)`,
    [fixture.targetRoute, threadId, fixture.accountId, postId],
  );
  const subjectId = newId(fixture.targetRoute);
  await db.admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision)
     VALUES ($1,$2,'schema:Book',$2,'visible',1)`,
    [fixture.targetRoute, subjectId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,'reaction:set','(,)',$3)`,
    [fixture.targetRoute, subjectId, fixture.accountId],
  );
  await db.admin.query(
    `INSERT INTO content.reaction(route,actor_account_id,target_kind,target_route,target_id,kind,updated_at)
     VALUES ($1,$2,'thread',$3,$4,'like',clock_timestamp()),
            ($1,$2,'post',$3,$5,'like',clock_timestamp()),
            ($1,$2,'subject',$3,$6,'like',clock_timestamp())`,
    [fixture.home, fixture.accountId, fixture.targetRoute, threadId, postId, subjectId],
  );
  return { threadId, postId, subjectId };
}

function reactionHistoryPopulation(): Population {
  const name = `reaction-clear-history-${crypto.randomUUID()}`;
  const historyPosition = nextHistoryPosition;
  nextHistoryPosition += 1_000_000_000;
  return {
    name,
    hotPartition: partitionOf(fixture.home),
    hotShare: 0.5,
    rows: ({ route, ordinal, partition, hot }) => {
      const contentRoute = hot
        ? fixture.targetRoute
        : partitionOf(route) === partitionOf(fixture.targetRoute)
          ? (route + 16) % 65_536
          : route;
      const entries = Array.from({ length: populationMultiplier }, () => {
        const actorId = newId(route);
        const boardId = newId(contentRoute);
        const subjectId = newId(contentRoute);
        const threadId = newId(contentRoute);
        const postId = newId(contentRoute);
        const revisionId = newId(contentRoute);
        return { actorId, boardId, subjectId, threadId, postId, revisionId };
      });
      return {
        'access.account': entries.map(({ actorId }) => ({
          route,
          account_id: actorId,
          kind: 'actor',
          state: 'active',
          transaction_id: actorId,
        })),
        'access.membership_inverse': entries.map(({ actorId, boardId }) => ({
          route,
          account_id: actorId,
          kind: 'realm',
          group_id: boardId,
          reservation_id: actorId,
          transaction_id: actorId,
        })),
        'access.resource_grant': entries.map(({ actorId, threadId }) => ({
          route: contentRoute,
          resource_id: threadId,
          subject_id: actorId,
          subject_role: '',
          action: 'reaction:set',
          valid: '(,)',
          transaction_id: actorId,
          subject_kind: 'identity',
        })),
        'access.resource_role_grant': entries.map(({ actorId, threadId }) => ({
          route: contentRoute,
          resource_id: threadId,
          subject_kind: 'identity',
          subject_id: actorId,
          subject_role: '',
          grant_role: 'content.thread.owner',
          valid: '(,)',
          transaction_id: actorId,
        })),
        'access.resource_denial': entries.map(({ actorId, threadId }) => ({
          route: contentRoute,
          resource_id: threadId,
          subject_id: actorId,
          subject_role: '',
          action: 'thread:read',
          reason: 'resource',
          valid: '(,)',
          transaction_id: actorId,
        })),
        'content.board': entries.map(({ boardId, subjectId: boardSubject }) => ({
          route: contentRoute,
          board_id: boardId,
          subject_id: boardSubject,
          title: 'Unrelated reaction board',
          visibility: 'published',
          security_revision: 1,
          recorded_transaction_id: fixture.managerId,
        })),
        'content.thread': entries.map(({ threadId, actorId, boardId, postId: firstPostId }) => ({
          route: contentRoute,
          thread_id: threadId,
          author_account_id: actorId,
          board_id: boardId,
          title: 'Unrelated reaction thread',
          visibility: 'published',
          security_revision: 1,
          recorded_transaction_id: actorId,
          first_post_id: firstPostId,
        })),
        'content.post': entries.map(({ threadId, actorId, postId, revisionId }) => ({
          route: contentRoute,
          thread_id: threadId,
          post_id: postId,
          author_account_id: actorId,
          head_revision_id: revisionId,
          visibility: 'published',
          security_revision: 1,
          recorded_transaction_id: actorId,
        })),
        'content.revision': entries.map(({ threadId, postId, revisionId, boardId }) => ({
          route: contentRoute,
          thread_id: threadId,
          post_id: postId,
          revision_id: revisionId,
          body: new Uint8Array(reactionBody),
          body_sha256: new Uint8Array(reactionBodyHash),
          search_text: 'growth',
          licence: 'CC0-1.0',
          subject_ids: [],
          board_id: boardId,
          availability: 'available',
          recorded_transaction_id: fixture.managerId,
        })),
        'semantic.subject': entries.map(({ subjectId }) => ({
          route: contentRoute,
          subject_id: subjectId,
          type: 'schema:Book',
          recorded_transaction_id: fixture.managerId,
          visibility: 'visible',
          security_revision: 1,
        })),
        'content.reaction': entries.map(({ actorId }) => ({
          route,
          actor_account_id: actorId,
          target_kind: 'thread',
          target_route: fixture.targetRoute,
          target_id: newId(fixture.targetRoute),
          kind: 'like',
          updated_at: '2026-10-25T00:00:00.000Z',
        })),
        'core.receipt': entries.map((entry, index) => ({
          partition_no: partition,
          principal_kind: 'account',
          principal_id: fixture.accountId,
          command_kind: 'content.reaction.history',
          idempotency_key: `${name}:${ordinal}:${index}`,
          request_digest: new Uint8Array(32),
          epoch: 1,
          position: historyPosition + ordinal * historyPositionStride + index + 1,
          transaction_id: newId(route),
          response: {},
        })),
        'core.outbox': entries.map((entry, index) => ({
          partition_no: partition,
          position: historyPosition + ordinal * historyPositionStride + index + 1,
          event_seq: 0,
          event_count: 1,
          epoch: 1,
          id: newId(route),
          type: 'com.rezics.test.reaction-history.v1',
          subject: entry.threadId,
          data: { ordinal, index },
        })),
      };
    },
    async finish(admin) {
      await admin.query(
        `UPDATE core.partition p SET position=GREATEST(p.position,h.position)
         FROM (SELECT partition_no,max(position) AS position FROM core.outbox
               WHERE type='com.rezics.test.reaction-history.v1' GROUP BY partition_no) h
         WHERE p.partition_no=h.partition_no`,
      );
    },
  };
}

test('Clearing a reaction stays within its bound as reactions grow', async () => {
  const failures: GrowthBoundError[] = [];
  const reports = [];
  for (const targetKind of ['thread', 'post', 'subject'] as const) {
    const population = reactionHistoryPopulation();
    const targets = await Promise.all(Array.from({ length: scales.length * 6 }, () => makeReactionKeys()));
    const name = `Reaction clear ${targetKind}`;
    const report = await collectGrowth(name, failures, () =>
      checkGrowth(fixture.db, {
        name: `Reaction clear ${targetKind}`,
        scales,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        async grow(db, scale, previous) {
          await seed(db, population, {
            from: previous * populationMultiplier,
            to: scale * populationMultiplier,
          });
        },
        async warmup(_db, _scale, repetition) {
          await diagnose({ name, phase: 'warmup', scale: _scale, repetition }, () =>
            clearOneReaction(targetKind, targets[repetition]!),
          );
        },
        async operation(_db, scale, repetition) {
          await diagnose({ name, phase: 'operation', scale, repetition }, () =>
            clearOneReaction(targetKind, targets[repetition]!),
          );
        },
      }),
    );
    if (report) reports.push(report);
  }
  for (const report of reports) expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  console.log(
    'Reaction clear slots',
    JSON.stringify(
      reports.map(({ name, samples }) => ({
        name,
        samples: samples.map(({ scale, cost }) => ({
          scale,
          rows: cost.rows,
          blocks: cost.blocks,
          statements: cost.statements,
        })),
      })),
    ),
  );
  throwGrowthFailures(failures);
}, 120_000);

async function clearOneReaction(
  targetKind: 'thread' | 'post' | 'subject',
  keys: Awaited<ReturnType<typeof makeReactionKeys>>,
): Promise<void> {
  const targetId = targetKind === 'thread' ? keys.threadId : targetKind === 'post' ? keys.postId : keys.subjectId;
  const outcome = await clearReaction(
    { pool: fixture.db.pool, access: fixture.access },
    actor,
    { targetKind, targetId },
    request(),
  );
  expect(outcome?.partition).toBe(partitionOf(fixture.home));
}

function moderationPopulation(): Population {
  const name = `lift-takedown-history-${crypto.randomUUID()}`;
  const historyPosition = nextHistoryPosition;
  nextHistoryPosition += 1_000_000_000;
  return {
    name,
    hotPartition: partitionOf(fixture.targetRoute),
    hotShare: 0.5,
    rows: ({ route, ordinal, partition, hot }) => {
      const contentRoute = hot
        ? fixture.targetRoute
        : partitionOf(route) === partitionOf(fixture.targetRoute)
          ? (route + 16) % 65_536
          : route;
      const entries = Array.from({ length: populationMultiplier }, () => {
        const threadId = newId(contentRoute);
        const postId = newId(contentRoute);
        const revisionId = newId(contentRoute);
        const id = newId(route);
        return { threadId, postId, revisionId, id, contentRoute };
      });
      return {
        'content.thread': entries.map(({ threadId, postId, contentRoute }) => ({
          route: contentRoute,
          thread_id: threadId,
          author_account_id: fixture.managerId,
          board_id: newId(boardRoute),
          title: 'Historical moderated thread',
          visibility: 'taken_down',
          security_revision: 1,
          recorded_transaction_id: fixture.managerId,
          first_post_id: postId,
        })),
        'content.post': entries.map(({ threadId, postId, revisionId, contentRoute }) => ({
          route: contentRoute,
          thread_id: threadId,
          post_id: postId,
          author_account_id: fixture.managerId,
          head_revision_id: revisionId,
          visibility: 'taken_down',
          security_revision: 1,
          recorded_transaction_id: fixture.managerId,
        })),
        'content.revision': entries.map(({ threadId, postId, revisionId, contentRoute }) => ({
          route: contentRoute,
          thread_id: threadId,
          post_id: postId,
          revision_id: revisionId,
          body: new Uint8Array(reactionBody),
          body_sha256: new Uint8Array(reactionBodyHash),
          search_text: 'growth',
          licence: 'CC0-1.0',
          subject_ids: [],
          board_id: newId(contentRoute),
          availability: 'available',
          recorded_transaction_id: fixture.managerId,
        })),
        'core.receipt': entries.map(({ id }, index) => ({
          partition_no: partition,
          principal_kind: 'account',
          principal_id: fixture.accountId,
          command_kind: 'content.lift.history',
          idempotency_key: `${name}:${ordinal}:${index}`,
          request_digest: new Uint8Array(32),
          epoch: 1,
          position: historyPosition + ordinal * historyPositionStride + index + 1,
          transaction_id: id,
          response: {},
        })),
        'core.outbox': entries.map(({ id, threadId }, index) => ({
          partition_no: partition,
          position: historyPosition + ordinal * historyPositionStride + index + 1,
          event_seq: 0,
          event_count: 1,
          epoch: 1,
          id,
          type: 'com.rezics.test.lift-history.v1',
          subject: threadId,
          data: { ordinal, index },
        })),
      };
    },
    async finish(admin) {
      await admin.query(
        `UPDATE core.partition p SET position=GREATEST(p.position,h.position)
         FROM (SELECT partition_no,max(position) AS position FROM core.outbox
               WHERE type='com.rezics.test.lift-history.v1' GROUP BY partition_no) h
         WHERE p.partition_no=h.partition_no`,
      );
    },
  };
}

async function makeTakedownTarget(kind: 'thread' | 'post'): Promise<{ kind: 'thread' | 'post'; id: string }> {
  const route = fixture.targetRoute;
  const id = newId(route);
  const transactionId = newId(route);
  if (kind === 'thread') {
    await fixture.db.admin.query(
      `INSERT INTO content.thread
         (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,'Lift growth','taken_down',1,$5)`,
      [route, id, fixture.managerId, newId(boardRoute), transactionId],
    );
  } else {
    const threadId = newId(route);
    const revisionId = newId(route);
    const client = await fixture.db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO content.thread
           (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
         VALUES ($1,$2,$3,$4,'Lift growth','taken_down',1,$5)`,
        [route, threadId, fixture.managerId, newId(boardRoute), transactionId],
      );
      await client.query(
        `INSERT INTO content.post
           (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
         VALUES ($1,$2,$3,$4,$5,'taken_down',1,$6)`,
        [route, threadId, id, fixture.managerId, revisionId, transactionId],
      );
      await client.query(
        `INSERT INTO content.revision
           (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
         VALUES ($1,$2,$3,$4,$5,$6,'growth','CC0-1.0','{}',$7,'available',$8)`,
        [route, threadId, id, revisionId, reactionBody, reactionBodyHash, newId(boardRoute), transactionId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return { kind, id };
}

async function liftOne(target: { kind: 'thread' | 'post'; id: string }): Promise<void> {
  const events: CommandEvent[] = [];
  const outcome = await runCommand(
    fixture.db.pool,
    {
      partition: partitionOf(routeOf(target.id)!),
      receipt: {
        actorAccountId: fixture.accountId,
        kind: 'content.fixture.lift-takedown',
        key: crypto.randomUUID(),
        digest: new Uint8Array(32),
      },
    },
    async (transaction) => {
      const value = await liftTakedown(transaction, { target }, { events });
      return { value, events };
    },
  );
  expect(outcome.value).toMatchObject({ targetId: target.id });
  expect(events).toHaveLength(1);
}

test('Lifting a takedown stays within its bound as moderation history grows', async () => {
  const failures: GrowthBoundError[] = [];
  const reports = [];
  for (const kind of ['thread', 'post'] as const) {
    const population = moderationPopulation();
    const targets = await Promise.all(Array.from({ length: scales.length * 6 }, () => makeTakedownTarget(kind)));
    const name = `Lift takedown ${kind}`;
    const report = await collectGrowth(name, failures, () =>
      checkGrowth(fixture.db, {
        name,
        scales,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        async grow(db, scale, previous) {
          await seed(db, population, {
            from: previous * populationMultiplier,
            to: scale * populationMultiplier,
          });
        },
        async warmup(_db, _scale, repetition) {
          await diagnose({ name, phase: 'warmup', scale: _scale, repetition }, () => liftOne(targets[repetition]!));
        },
        async operation(_db, scale, repetition) {
          await diagnose({ name, phase: 'operation', scale, repetition }, () => liftOne(targets[repetition]!));
        },
      }),
    );
    if (report) reports.push(report);
  }
  for (const report of reports) expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  console.log(
    'Lift takedown',
    JSON.stringify(
      reports.map((report) => ({
        name: report.name,
        samples: report.samples.map(({ scale, cost }) => ({
          scale,
          rows: cost.rows,
          blocks: cost.blocks,
          statements: cost.statements,
        })),
      })),
    ),
  );
  throwGrowthFailures(failures);
}, 120_000);

type WorkflowFixture = {
  readonly event: CloudEvent;
  readonly source: ContentWorkSource;
  readonly workflowId: string;
  readonly mediaId?: string;
  readonly operationId?: string;
  readonly threadId?: string;
  readonly actor?: AccountActor;
  readonly pageSize?: number;
};

function source(epoch: number, position: bigint): ContentWorkSource {
  return { epoch, partition: workPartition, position: position.toString(), eventIndex: 0 };
}

function cloudEvent(
  position: bigint,
  epoch: number,
  event: {
    id: string;
    type: string;
    subject: string;
    data: Record<string, unknown>;
  },
): CloudEvent {
  return {
    specversion: '1.0',
    id: event.id,
    source: `urn:rezics:log:${workPartition}.${epoch}`,
    type: event.type,
    subject: event.subject,
    time: '2026-10-27T00:00:00.000Z',
    datacontenttype: 'application/json',
    sequence: position.toString().padStart(19, '0'),
    data: event.data,
  };
}

function matchingEffect(type: string) {
  const effect = effects.find((candidate) => candidate.types.includes(type));
  if (!effect) throw new Error(`No registered effect handles ${type}`);
  return effect;
}

async function nextWorkPosition(): Promise<{ readonly epoch: number; readonly position: bigint }> {
  const row = (
    await fixture.db.admin.query<{ epoch: number; position: string }>(
      'SELECT epoch,position::text FROM core.partition WHERE partition_no=$1',
      [workPartition],
    )
  ).rows[0];
  if (!row) throw new Error('Missing content work partition');
  return { epoch: row.epoch, position: BigInt(row.position) + 1n };
}

async function insertOutboxEvent(event: CloudEvent, position: bigint, epoch: number): Promise<void> {
  await fixture.db.admin.query(
    `INSERT INTO core.outbox(partition_no,position,event_seq,event_count,epoch,id,type,subject,data)
     VALUES ($1,$2,0,1,$3,$4,$5,$6,$7)`,
    [workPartition, position.toString(), epoch, event.id, event.type, event.subject, event.data],
  );
  await fixture.db.admin.query(
    'UPDATE core.partition SET position=GREATEST(position,$2::bigint) WHERE partition_no=$1',
    [workPartition, position.toString()],
  );
}

async function prepareImageWork(position: bigint, epoch: number): Promise<WorkflowFixture> {
  const mediaId = newId(workRoute);
  const containerId = newId(workRoute);
  const transactionId = newId(workRoute);
  const key = `m/${mediaId}/original`;
  const bytesHash = hash(mediaBytes);
  mediaObjects.set(key, mediaBytes);
  await fixture.db.admin.query(
    `INSERT INTO content.media
       (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,actual_byte_count,
        sha256,state,key,transaction_id)
     VALUES ($1,$2,$3,$4,$5,'post-image','image/png',$6,$6,$7,'uploaded',$8,$9)`,
    [
      workRoute,
      mediaId,
      containerId,
      fixture.accountId,
      crypto.randomUUID(),
      mediaBytes.byteLength,
      bytesHash,
      key,
      transactionId,
    ],
  );
  const event = cloudEvent(position, epoch, {
    id: newId(workRoute),
    type: 'com.rezics.content.media.uploaded.v1',
    subject: mediaId,
    data: { mediaId, containerId, actorId: fixture.accountId },
  });
  await insertOutboxEvent(event, position, epoch);
  return {
    event,
    source: source(epoch, position),
    workflowId: contentWorkWorkflowId({ epoch, partition: workPartition, position }, 0, 'image'),
    mediaId,
  };
}

const coverCredit = {
  rightsHolder: 'Growth fixture',
  via: { name: 'Fixture catalogue', url: 'https://catalogue.example.org/item' },
  license: 'CC0-1.0',
  obligations: [],
};
const coverReference = {
  parts: [
    { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://catalogue.example.org/item' } },
    { property: { id: 'schema:author' }, value: { type: 'somevalue' } },
  ],
};

async function prepareImportWork(position: bigint, epoch: number): Promise<WorkflowFixture> {
  const mediaId = newId(workRoute);
  const containerId = newId(workRoute);
  const externalId = `growth-${crypto.randomUUID()}`;
  const provenance = {
    source: 'catalogue',
    external_id: externalId,
    record_revision: 'growth-v1',
    digest: 'b'.repeat(64),
    converter_revision: 'growth-converter',
    field_group: 'cover',
    references: [coverReference],
  };
  const sourceRoute = tupleRoute(routeKey, provenance.source, externalId);
  await fixture.db.admin.query(
    `INSERT INTO content.source_fences(route,source,external_id,field_group,taken_down,security_revision)
     VALUES ($1,$2,$3,'cover',false,1)`,
    [sourceRoute, provenance.source, externalId],
  );
  await fixture.db.admin.query(
    `INSERT INTO content.media
       (route,media_id,container_id,uploader_id,reservation_request_id,purpose,state,key,transaction_id,
        source_url,credit,provenance)
     VALUES ($1,$2,$3,$4,$5,'cover','reserved',$6,$7,$8,$9,$10)`,
    [
      workRoute,
      mediaId,
      containerId,
      fixture.accountId,
      crypto.randomUUID(),
      `m/${mediaId}/original`,
      newId(workRoute),
      'https://images.example.org/cover.png',
      coverCredit,
      provenance,
    ],
  );
  const event = cloudEvent(position, epoch, {
    id: newId(workRoute),
    type: 'com.rezics.content.media.import-requested.v1',
    subject: mediaId,
    data: { mediaId },
  });
  await insertOutboxEvent(event, position, epoch);
  return {
    event,
    source: source(epoch, position),
    workflowId: contentWorkWorkflowId({ epoch, partition: workPartition, position }, 0, 'importFromUrl', mediaId),
    mediaId,
  };
}

async function prepareErasureWork(position: bigint, epoch: number): Promise<WorkflowFixture> {
  const operationId = newId(workRoute);
  const threadId = newId(workRoute);
  const boardId = newId(workRoute);
  const pageSize = 100;
  const postIds = Array.from({ length: pageSize }, () => newId(workRoute)).sort();
  const revisionIds = postIds.map(() => newId(workRoute));
  const transactionId = newId(workRoute);
  const idem = crypto.randomUUID();
  if (actor.requestedBy !== null) throw new Error('The work fixture requires an initiating account without delegation');
  const operation = {
    route: workRoute,
    id: operationId,
    kind: 'content.author-erasure',
    sourceId: operationId,
  } as const;
  const selection = { threadId, authorId: fixture.accountId } as const;
  const createdAt = '2025-01-01T00:00:00.000Z';
  const account = (
    await fixture.db.admin.query<{ minimumAuthnEpoch: string; operatorAccountId: string | null }>(
      `SELECT minimum_authn_epoch::text AS "minimumAuthnEpoch", operator_account_id::text AS "operatorAccountId"
       FROM access.account WHERE route=$1 AND account_id=$2`,
      [routeOf(fixture.accountId), fixture.accountId],
    )
  ).rows[0];
  if (!account) throw new Error('Missing author-erasure fixture account');
  const content = await fixture.db.admin.connect();
  try {
    await content.query('BEGIN');
    await content.query(
      `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,'Work erasure','published',1,$4)`,
      [workRoute, boardId, newId(workRoute), transactionId],
    );
    await content.query(
      `INSERT INTO content.thread
         (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id)
       VALUES ($1,$2,$3,$4,'Work erasure','published',1,$5,$6)`,
      [workRoute, threadId, fixture.accountId, boardId, transactionId, postIds[0]],
    );
    await content.query(
      `INSERT INTO content.post
         (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,
          recorded_transaction_id,created_at)
       SELECT $1,$2,p.post_id,$3,p.revision_id,'published',1,p.post_id,$4::timestamptz
       FROM unnest($5::uuid[],$6::uuid[]) AS p(post_id,revision_id)`,
      [workRoute, threadId, fixture.accountId, createdAt, postIds, revisionIds],
    );
    await content.query(
      `INSERT INTO content.revision
         (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,
          availability,recorded_transaction_id,recorded_at)
       SELECT $1,$2,r.post_id,r.revision_id,$3,sha256($3),'growth erasure','CC0-1.0','{}',$4,
              'available',r.post_id,$5::timestamptz
       FROM unnest($6::uuid[],$7::uuid[]) AS r(post_id,revision_id)`,
      [workRoute, threadId, reactionBody, boardId, createdAt, postIds, revisionIds],
    );
    await content.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       SELECT $1,post_id,$2,'post:erase','(,)',post_id FROM unnest($3::uuid[]) AS p(post_id)
       ON CONFLICT DO NOTHING`,
      [workRoute, workActor.accountId, postIds],
    );
    await content.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES ($1,$2,$2,'account:read','(,)',$2) ON CONFLICT DO NOTHING`,
      [routeOf(workActor.accountId), workActor.accountId],
    );
    await content.query('COMMIT');
  } catch (error) {
    await content.query('ROLLBACK');
    throw error;
  } finally {
    content.release();
  }
  const upper = (
    await fixture.db.admin.query<{ createdAt: string; postId: string }>(
      `SELECT created_at::text AS "createdAt", post_id::text AS "postId"
       FROM content.post WHERE route=$1 AND thread_id=$2 ORDER BY created_at DESC,post_id DESC LIMIT 1`,
      [workRoute, threadId],
    )
  ).rows[0];
  if (!upper) throw new Error('Missing author-erasure page upper bound');
  const target = { route: workRoute, id: postIds[0]! } as const;
  const sourceDigest = hash(
    canonicalize({
      operation,
      target,
      selection: {
        ...selection,
        upperCreatedAt: upper.createdAt,
        upperPostId: upper.postId,
      },
    })!,
  );
  const requestDigest = hash(canonicalize([principalCommandIdentity(workActor), selection])!);
  const record: DurableInitiatorRecord = {
    operation,
    initiatorAccountId: workActor.accountId,
    actor: workActor,
    recordedTransactionId: transactionId,
    sourceDigest,
    originalDelegation: null,
    originalAccount: {
      minimumAuthnEpoch: account.minimumAuthnEpoch,
      operatorAccountId: account.operatorAccountId,
    },
    creation: {
      commandKind: operation.kind,
      idempotencyKey: idem,
      requestDigest,
      target,
    },
  };
  const durableInitiator = durableInitiatorCommitment(record);
  const event = cloudEvent(position, epoch, {
    id: newId(workRoute),
    type: 'com.rezics.content.author-erasure.requested.v1',
    subject: operationId,
    data: { operationId, threadId, authorId: fixture.accountId },
  });
  await fixture.db.admin.query(
    `INSERT INTO content.operation
       (route,operation_id,initiator_account_id,author_account_id,thread_id,anchor_post_id,actor_kind,actor_account_id,
        actor_client_id,actor_scopes,actor_requested_by,actor_authn_epoch,empty_scope,upper_created_at,upper_post_id,
        requested_at,recorded_transaction_id,source_digest,original_minimum_authn_epoch,original_operator_account_id,
        creation_command_kind,creation_idempotency_key,
        creation_request_digest,creation_target_route,creation_target_id)
     VALUES ($1,$2,$3,$3,$4,$5,'account',$3,$6,$7,$8,$9,false,$10,$11,clock_timestamp(),$12,$13,$14,$15,
             'content.author-erasure',$16,$17,$1,$5)`,
    [
      workRoute,
      operationId,
      fixture.accountId,
      threadId,
      target.id,
      workActor.clientId,
      workActor.scopes,
      workActor.requestedBy,
      workActor.authnEpoch,
      upper.createdAt,
      upper.postId,
      transactionId,
      sourceDigest,
      account.minimumAuthnEpoch,
      account.operatorAccountId,
      idem,
      requestDigest,
    ],
  );
  await fixture.db.admin.query(
    `INSERT INTO core.receipt
       (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
     VALUES ($1,'account',$2,'content.author-erasure',$3,decode($4,'hex'),$5,$6,$7,$8)`,
    [
      workPartition,
      fixture.accountId,
      idem,
      requestDigest,
      epoch,
      position.toString(),
      transactionId,
      { operationId, durableInitiator },
    ],
  );
  await insertOutboxEvent(event, position, epoch);
  return {
    event,
    source: source(epoch, position),
    workflowId: contentWorkWorkflowId({ epoch, partition: workPartition, position }, 0, 'authorErase', operationId),
    operationId,
    threadId,
    actor: workActor,
    pageSize,
  };
}

function workHistoryPopulation(): Population {
  const name = `content-workflow-history-${crypto.randomUUID()}`;
  const historyPosition = nextHistoryPosition;
  nextHistoryPosition += 1_000_000_000;
  const historyTypes = ['content.image', 'content.importFromUrl', 'content.authorErase'] as const;
  return {
    name,
    hotPartition: workPartition,
    hotShare: 0.5,
    rows: ({ route, partition, ordinal, hot }) => {
      const rows = Array.from({ length: populationMultiplier }, (_, index) => {
        const mediaId = newId(route);
        const threadId = newId(route);
        const boardId = newId(route);
        const operationId = newId(route);
        const anchorPostId = newId(route);
        const revisionId = newId(route);
        const transactionId = newId(route);
        const idem = `${name}:${ordinal}:${index}`;
        const digest = hash(idem);
        const historyWorkflowRows = historyTypes.map((workflowName, workflowIndex) => {
          const workflowId = `${name}:${ordinal}:${index}:${workflowIndex}`;
          const queueName = workflowIndex === 1 ? 'import' : workflowIndex === 2 ? 'governance' : 'effects';
          return {
            'dbos.workflow_status': [
              {
                workflow_uuid: workflowId,
                status: 'SUCCESS',
                name: workflowName,
                queue_name: queueName,
                authenticated_user: '',
                assumed_role: '',
                authenticated_roles: '',
                executor_id: '',
                application_id: 'rezics-kernel',
                created_at: Date.parse('2025-01-01T00:00:00.000Z'),
                updated_at: Date.parse('2025-01-01T00:00:00.000Z'),
                recovery_attempts: 0,
                inputs: '[]',
                queue_partition_key: String(hot ? workPartition : partition),
                serialization: 'JSON',
              },
            ],
            'dbos.workflow_input': [{ workflow_uuid: workflowId, inputs: '[]' }],
            'dbos.workflow_output': [{ workflow_uuid: workflowId, output: 'null', error: '' }],
            'dbos.operation_outputs': [
              {
                workflow_uuid: workflowId,
                function_id: 1,
                function_name: `${workflowName}.step`,
                output: 'null',
                error: '',
              },
            ],
            ...(workflowIndex === 2
              ? {
                  'dbos.workflow_events': [
                    {
                      workflow_uuid: workflowId,
                      key: 'content.authorErasure.progress',
                      value: '{"processedPosts":0,"erasedRevisions":0,"steps":0}',
                      serialization: 'JSON',
                    },
                  ],
                  'dbos.workflow_events_history': [
                    {
                      workflow_uuid: workflowId,
                      function_id: 1,
                      key: 'content.authorErasure.progress',
                      value: '{"processedPosts":0,"erasedRevisions":0,"steps":0}',
                      serialization: 'JSON',
                    },
                  ],
                }
              : {}),
          };
        });
        const merged: Record<string, Record<string, unknown>[]> = {};
        for (const workflowRows of historyWorkflowRows)
          for (const [table, values] of Object.entries(workflowRows)) (merged[table] ??= []).push(...values);
        merged['content.board'] = [
          {
            route,
            board_id: boardId,
            subject_id: newId(route),
            title: 'Historical workflow board',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
          },
        ];
        merged['content.thread'] = [
          {
            route,
            thread_id: threadId,
            author_account_id: fixture.managerId,
            board_id: boardId,
            title: 'Historical workflow thread',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            first_post_id: anchorPostId,
          },
        ];
        merged['content.post'] = [
          {
            route,
            thread_id: threadId,
            post_id: anchorPostId,
            author_account_id: fixture.managerId,
            head_revision_id: revisionId,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: new Date('2025-01-01T00:00:00.000Z'),
          },
        ];
        merged['content.revision'] = [
          {
            route,
            thread_id: threadId,
            post_id: anchorPostId,
            revision_id: revisionId,
            body: new Uint8Array(reactionBody),
            body_sha256: new Uint8Array(reactionBodyHash),
            search_text: 'growth workflow history',
            licence: 'CC0-1.0',
            subject_ids: [],
            board_id: boardId,
            availability: 'available',
            recorded_transaction_id: transactionId,
            recorded_at: new Date('2025-01-01T00:00:00.000Z'),
          },
        ];
        merged['content.media'] = [
          {
            route,
            media_id: mediaId,
            container_id: newId(route),
            uploader_id: fixture.accountId,
            reservation_request_id: idem,
            purpose: 'cover',
            media_type: null,
            byte_count: null,
            declared_sha256: null,
            actual_byte_count: null,
            sha256: null,
            state: 'reserved',
            decision: null,
            key: `m/${mediaId}/original`,
            claimed_at: null,
            created_at: new Date('2025-01-01T00:00:00.000Z'),
            transaction_id: transactionId,
            erased: false,
            collection_pending: false,
            source_url: 'https://images.example.org/history.png',
            credit: coverCredit,
            provenance: {
              source: 'catalogue',
              external_id: idem,
              record_revision: 'history-v1',
              digest: 'd'.repeat(64),
              converter_revision: 'history-converter',
              field_group: 'cover',
              references: [coverReference],
            },
            taken_down: false,
            security_revision: 0,
          },
        ];
        merged['content.media_variant'] = [
          {
            route,
            media_id: mediaId,
            format: 'webp',
            width: 320,
            height: 200,
            media_type: 'image/webp',
            byte_count: 128,
            sha256: 'e'.repeat(64),
            key: `m/${mediaId}/webp-320`,
            transaction_id: transactionId,
          },
        ];
        merged['content.source_fences'] = [
          {
            route,
            source: 'catalogue',
            external_id: idem,
            field_group: 'cover',
            taken_down: false,
            security_revision: 1,
          },
        ];
        merged['content.operation'] = [
          {
            route,
            operation_id: operationId,
            initiator_account_id: fixture.accountId,
            author_account_id: fixture.accountId,
            thread_id: threadId,
            anchor_post_id: anchorPostId,
            actor_kind: 'account',
            actor_account_id: fixture.accountId,
            actor_client_id: workActor.clientId,
            actor_scopes: workActor.scopes,
            actor_requested_by: workActor.requestedBy,
            actor_authn_epoch: workActor.authnEpoch,
            empty_scope: true,
            upper_created_at: null,
            upper_post_id: null,
            requested_at: new Date('2025-01-01T00:00:00.000Z'),
            recorded_transaction_id: transactionId,
            native_workflow_id: null,
            source_epoch: null,
            source_partition: null,
            source_position: null,
            source_event_index: null,
            source_digest: 'f'.repeat(64),
            original_minimum_authn_epoch: '1',
            original_operator_account_id: null,
            original_delegation_transaction_id: null,
            original_delegation_issued_valid: null,
            creation_command_kind: 'content.author-erasure',
            creation_idempotency_key: idem,
            creation_request_digest: digest,
            creation_target_route: route,
            creation_target_id: anchorPostId,
          },
        ];
        merged['core.receipt'] = [
          {
            partition_no: partition,
            principal_kind: 'account',
            principal_id: fixture.accountId,
            command_kind: 'content.author-erasure',
            idempotency_key: idem,
            request_digest: Buffer.from(digest, 'hex'),
            epoch: 1,
            position: historyPosition + ordinal * historyPositionStride + index + 1,
            transaction_id: transactionId,
            response: { operationId, durableInitiator: 'f'.repeat(64) },
          },
        ];
        merged['core.outbox'] = [
          {
            partition_no: partition,
            position: historyPosition + ordinal * historyPositionStride + index + 1,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: newId(route),
            type: 'com.rezics.test.content-work-history.v1',
            subject: operationId,
            data: { ordinal, index },
          },
        ];
        return merged;
      });
      const collected: Record<string, Record<string, unknown>[]> = {};
      for (const row of rows)
        for (const [table, values] of Object.entries(row)) (collected[table] ??= []).push(...values);
      return collected;
    },
    async finish(admin) {
      await admin.query(
        `UPDATE core.partition p SET position=GREATEST(p.position,h.position)
         FROM (SELECT partition_no,max(position) AS position FROM core.outbox
               WHERE type='com.rezics.test.content-work-history.v1' GROUP BY partition_no) h
         WHERE p.partition_no=h.partition_no`,
      );
    },
  };
}

async function enqueueWorkflowFixture(item: WorkflowFixture): Promise<void> {
  const type = item.event.type;
  await matchingEffect(type).run(item.event);
  const status = await workClient!.getWorkflow(item.workflowId);
  expect(status?.workflowName).toBe(
    type === 'com.rezics.content.media.uploaded.v1'
      ? CONTENT_WORKFLOWS.image
      : type === 'com.rezics.content.media.import-requested.v1'
        ? CONTENT_WORKFLOWS.importFromUrl
        : CONTENT_WORKFLOWS.authorErase,
  );
  const result = await DBOS.retrieveWorkflow(item.workflowId).getResult();
  if (type === 'com.rezics.content.media.uploaded.v1')
    expect(result).toMatchObject({ mediaId: item.mediaId, state: 'available' });
  if (type === 'com.rezics.content.media.import-requested.v1')
    expect(result).toMatchObject({ mediaId: item.mediaId, state: 'uploaded' });
  if (type === 'com.rezics.content.author-erasure.requested.v1')
    expect(result).toEqual({ processedPosts: item.pageSize, erasedRevisions: item.pageSize });
}

type WorkPass = {
  readonly image: WorkflowFixture;
  readonly imported: WorkflowFixture;
  readonly erasure: WorkflowFixture;
};

async function prepareWorkPass(): Promise<WorkPass> {
  const imagePosition = await nextWorkPosition();
  const image = await prepareImageWork(imagePosition.position, imagePosition.epoch);
  const importPosition = await nextWorkPosition();
  const imported = await prepareImportWork(importPosition.position, importPosition.epoch);
  const erasurePosition = await nextWorkPosition();
  const erasure = await prepareErasureWork(erasurePosition.position, erasurePosition.epoch);
  return { image, imported, erasure };
}

async function oneWorkPass(pass: WorkPass): Promise<void> {
  const { image, imported, erasure } = pass;
  await enqueueWorkflowFixture(image);
  await enqueueWorkflowFixture(imported);
  await enqueueWorkflowFixture(erasure);
  await operationClient!.enqueue(
    {
      operationId: erasure.operationId!,
      threadId: erasure.threadId!,
      authorId: fixture.accountId,
      actor: erasure.actor!,
    },
    context(),
  );
  const status = await operationClient!.status(erasure.workflowId, { deadline: Date.now() + 30_000 });
  expect(status).toMatchObject({
    done: true,
    response: { processedPosts: erasure.pageSize, erasedRevisions: erasure.pageSize },
  });
}

test('Content work enqueue, status and persistence stay within their bound as workflow history grows', async () => {
  const failures: GrowthBoundError[] = [];
  const population = workHistoryPopulation();
  const passes: WorkPass[] = [];
  for (let index = 0; index < scales.length * 6; index++) passes.push(await prepareWorkPass());
  const name = 'Content work enqueue, status and persistence';
  const report = await collectGrowth(name, failures, () =>
    checkGrowth(fixture.db, {
      name,
      scales,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(db, scale, previous) {
        const perOrdinal = populationMultiplier;
        await seed(db, population, { from: previous * perOrdinal, to: scale * perOrdinal });
      },
      async warmup(_db, scale, repetition) {
        await diagnose({ name, phase: 'warmup', scale, repetition }, () => oneWorkPass(passes[repetition]!));
      },
      async operation(_db, scale, repetition) {
        await diagnose({ name, phase: 'operation', scale, repetition }, () => oneWorkPass(passes[repetition]!));
      },
    }),
  );
  if (report) {
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
    console.log(
      'Content work enqueue, status and persistence',
      JSON.stringify(
        report.samples.map(({ scale, cost }) => ({
          scale,
          rows: cost.rows,
          blocks: cost.blocks,
          statements: cost.statements,
        })),
      ),
    );
  }
  throwGrowthFailures(failures);
}, 300_000);
