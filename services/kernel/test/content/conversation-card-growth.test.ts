import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { threadTarget } from '../../src/content/commands.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  capture as captureDatabase,
  costOf,
  openGrowthDatabase,
  type Capture,
  type GrowthDatabase,
} from '../support/growth.ts';
import {
  RankingWorld,
  requireStatus,
  startRankingWorker,
  type RankedThread,
  type RankingRuntime,
} from './board-ranking-native-convergence-fixture.ts';
import { createReactionRelayBase } from './reaction-relay-convergence-fixture.ts';

const scales = [256, 1024, 4096] as const;
const pageSize = 20;
const staleContinuationRows = 65;
const axes = ['unrelated-content', 'selected-history', 'account-authority', 'repair-backlog'] as const;
type Axis = (typeof axes)[number];
type Population = {
  threadIds: string[];
  postIds: string[];
  revisionIds: string[];
  historyPostIds: string[];
  transactionIds: string[];
  boardIds: string[];
};
type PageMeasurement = {
  homeRequestBytes: number;
  subjectRequestBytes: number;
  admittedBytes: number;
  retainedUtf8Bytes: number;
  materializedUtf8Bytes: number;
  serializedUtf8Bytes: number;
  snapshotReads: number;
  poolQueries: number;
  poolRequestBytes: number;
  poolResponseBytes: number;
  backendCount: number;
  runnerQueries: number;
  runnerRows: number;
  runnerBlocks: number;
  jsonStringifies: number;
  jsonSerializedUtf8: number;
  jsonParses: number;
  jsonParsedUtf8: number;
  homeKeys: string;
  subjectKeys: string;
  representedHomes: string;
};
type Sample = {
  scale: number;
  capture: Capture;
  cost: ReturnType<typeof costOf>;
  measurement: PageMeasurement;
};

let database: GrowthDatabase;
let base: Awaited<ReturnType<typeof createReactionRelayBase>>;
let world: RankingWorld;
let runtime: RankingRuntime | undefined;
let boardId = '';
let subjectId = '';
let subjectRoute = 0;
let realmId = '';
let contentRoute = 0;
let sourceRoute = 0;
let selected: RankedThread[] = [];
let selectedThreadIds: string[] = [];
let representedHomePartitions: number[] = [];
let activityAt = '';
let staleThreadIds: string[] = [];

beforeAll(async () => {
  database = await openGrowthDatabase();
  base = await createReactionRelayBase(database.url);

  // Keep HTTP, Access and Content on the growth pool so the full route is charged.
  const authenticate = base.system.access.authenticate;
  base.system.access.authenticate = (token, context) => authenticate(token, { ...context, pool: database.pool });
  world = new RankingWorld(base, database.pool);
  await world.time(world.start);
  boardId = await world.board();
  const board = await database.admin.query<{ realm_id: string; subject_id: string }>(
    'SELECT realm_id, subject_id FROM content.board WHERE route=$1 AND board_id=$2',
    [routeOf(boardId), boardId],
  );
  if (!board.rows[0]) throw new Error('Growth board did not retain its current Subject and Realm');
  subjectId = board.rows[0].subject_id;
  subjectRoute = routeOf(subjectId)!;
  realmId = board.rows[0].realm_id;
  contentRoute = routeOf(boardId)!;

  const followed = await world.call('PUT', `/v1/follows/${subjectId}`, {
    bearer: world.base.other.bearer,
    key: randomUUID(),
  });
  requireStatus(followed, 200);

  const keys = Array.from({ length: 40 }, () => randomUUID());
  const targets = keys.map((key) => threadTarget(world.base.system.routeKey, world.base.author.accountId, key));
  const partitions = [...new Set(targets.map((target) => partitionOf(target.route)))];
  runtime = await startRankingWorker(world, partitions);

  const start = Date.parse(world.start);
  for (let ordinal = 0; ordinal < keys.length; ordinal++) {
    const key = keys[ordinal]!;
    const target = targets[ordinal]!;
    await world.time(new Date(start + ordinal * 1000).toISOString());
    const created = await world.capture(partitionOf(target.route), () =>
      world.command(
        'POST',
        '/v1/threads',
        {
          title: `Conversation card ${ordinal + 1}`,
          body: fromPlainText(`Opening contribution ${ordinal + 1}`),
          licence: 'CC0-1.0',
          subjectIds: [subjectId],
          boardId,
        },
        world.base.author,
        201,
        key,
      ),
    );
    await runtime.consume(created.envelopes);
    const thread = created.value.thread;
    selected.push({
      id: thread.id,
      postId: thread.firstPost.id,
      boardId,
      createdAt: thread.createdAt,
      activityAt: thread.createdAt,
      score: 0,
      reactions: {},
    });
  }
  selectedThreadIds = selected.map(({ id }) => id);
  representedHomePartitions = [
    ...new Set(selected.slice(-pageSize).map(({ id }) => partitionOf(routeOf(id)!))),
  ].sort((left, right) => left - right);

  const startThread = selected.at(-1)!;
  sourceRoute = routeOf(startThread.id)!;
  const firstReply = await world.reply(startThread, world.base.author, new Date(start + 41_000).toISOString());
  await runtime.consume(firstReply.envelopes);
  const secondReply = await world.reply(startThread, world.base.author, new Date(start + 42_000).toISOString());
  await runtime.consume(secondReply.envelopes);
  activityAt = secondReply.value.post.createdAt;
}, 300_000);

afterAll(async () => {
  if (staleThreadIds.length)
    await database?.admin.query('DELETE FROM content.subject_thread WHERE route=$1 AND thread_id=ANY($2::uuid[])', [
      subjectRoute,
      staleThreadIds,
    ]);
  await runtime?.stop();
  await base?.system.close();
  await database?.close();
});

function utf8Json(value: unknown, stringify: typeof JSON.stringify): number {
  const text = stringify(value);
  return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0;
}

async function withJsonMeter<T>(operation: (stringify: typeof JSON.stringify) => Promise<T>) {
  const meter = { stringifies: 0, serializedUtf8: 0, parses: 0, parsedUtf8: 0 };
  const originalStringify = JSON.stringify;
  const originalParse = JSON.parse;
  Object.defineProperty(JSON, 'stringify', {
    configurable: true,
    writable: true,
    value: (value: unknown, replacer?: unknown, space?: unknown) => {
      const text = originalStringify(value as never, replacer as never, space as never);
      if (typeof text === 'string') {
        meter.stringifies++;
        meter.serializedUtf8 += Buffer.byteLength(text, 'utf8');
      }
      return text;
    },
  });
  Object.defineProperty(JSON, 'parse', {
    configurable: true,
    writable: true,
    value: (text: string, reviver?: unknown) => {
      meter.parses++;
      meter.parsedUtf8 += Buffer.byteLength(text, 'utf8');
      return originalParse(text, reviver as never);
    },
  });
  try {
    return { value: await operation(originalStringify), meter };
  } finally {
    Object.defineProperty(JSON, 'stringify', { configurable: true, writable: true, value: originalStringify });
    Object.defineProperty(JSON, 'parse', { configurable: true, writable: true, value: originalParse });
  }
}

function activityFor(item: { summary?: Record<string, any> }): Record<string, any> | undefined {
  return item.summary?.conversationActivity;
}

function assertCurrentActivity(value: Record<string, any> | undefined, count: number): void {
  expect(value).toMatchObject({
    state: 'current',
    cohort: 'public',
    count: { kind: 'exact', value: count },
    lastActivityAt: activityAt,
  });
}

async function readHome() {
  const result = await world.call('GET', '/v1/feedItems?stream=home&limit=20', {
    bearer: world.base.other.bearer,
  });
  requireStatus(result, 200);
  if (result.value === null) throw new Error('Home feed response omitted its page');
  return { ...result, value: result.value };
}

async function readSubject(limit: number, cursor?: string) {
  const query = new URLSearchParams({ place: realmId, kind: 'discussion', limit: String(limit) });
  if (cursor !== undefined) query.set('cursor', cursor);
  const result = await world.call('GET', `/v1/subjects/${subjectId}/threads?${query}`, {
    bearer: world.base.author.bearer,
  });
  requireStatus(result, 200);
  if (result.value === null) throw new Error('Subject thread response omitted its page');
  return { ...result, value: result.value };
}

async function addSparseSubjectRows(): Promise<string[]> {
  const stale = Array.from({ length: staleContinuationRows }, (_, ordinal) => newId(sourceRoute));
  const staleRoute = stale.map((id) => routeOf(id)!);
  const staleAt = stale.map((_, ordinal) => new Date(Date.parse(world.start) + 19_900 - ordinal).toISOString());
  await database.admin.query(
    `INSERT INTO content.subject_thread
       (route, subject_id, thread_route, thread_id, place_id, kind, last_activity_at, source_epoch, source_position)
     SELECT $1, $2, item.thread_route, item.thread_id, $3, 'discussion', item.last_activity_at, 1, item.ordinal
       FROM unnest($4::integer[], $5::uuid[], $6::timestamptz[]) WITH ORDINALITY
         AS item(thread_route, thread_id, last_activity_at, ordinal)`,
    [subjectRoute, subjectId, realmId, staleRoute, stale, staleAt],
  );
  return stale;
}

function makePopulation(): Population {
  const limit = scales.at(-1)!;
  return {
    threadIds: Array.from({ length: limit }, () => newId(contentRoute)),
    postIds: Array.from({ length: limit }, () => newId(contentRoute)),
    revisionIds: Array.from({ length: limit }, () => newId(contentRoute)),
    historyPostIds: Array.from({ length: limit }, () => newId(sourceRoute)),
    transactionIds: Array.from({ length: limit }, () => randomUUID()),
    boardIds: Array.from({ length: limit }, () => newId(sourceRoute)),
  };
}

async function grow(axis: Axis, population: Population, scale: number): Promise<void> {
  const ids = population.threadIds.slice(0, scale);
  const posts = population.postIds.slice(0, scale);
  const revisions = population.revisionIds.slice(0, scale);
  const transactions = population.transactionIds.slice(0, scale);
  if (axis === 'unrelated-content') {
    await database.admin.query(
      `INSERT INTO content.thread
         (route, thread_id, author_account_id, board_id, title, visibility, security_revision, recorded_transaction_id, created_at)
       SELECT $1, item.thread_id, $2, $3, 'Unrelated growth thread', 'published', 1, item.transaction_id, $4
         FROM unnest($5::uuid[], $6::uuid[]) AS item(thread_id, transaction_id)`,
      [contentRoute, world.base.author.accountId, boardId, '2020-01-01T00:00:00Z', ids, transactions],
    );
    await database.admin.query(
      `INSERT INTO content.post
         (route, thread_id, post_id, author_account_id, head_revision_id, visibility, security_revision, recorded_transaction_id, created_at)
       SELECT $1, item.thread_id, item.post_id, $2, item.revision_id, 'published', 1, item.transaction_id, $3
         FROM unnest($4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[]) AS item(thread_id, post_id, revision_id, transaction_id)`,
      [contentRoute, world.base.author.accountId, '2020-01-01T00:00:00Z', ids, posts, revisions, transactions],
    );
    await database.admin.query(
      `INSERT INTO content.revision
         (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence, subject_ids,
          board_id, availability, recorded_transaction_id)
       SELECT $1, item.thread_id, item.post_id, item.revision_id, convert_to('Unrelated growth revision', 'UTF8'),
              digest(convert_to('Unrelated growth revision', 'UTF8'), 'sha256'), 'Unrelated growth revision',
              'CC0-1.0', ARRAY[$3::uuid], $2, 'available', item.transaction_id
         FROM unnest($4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[]) AS item(thread_id, post_id, revision_id, transaction_id)`,
      [contentRoute, boardId, subjectId, ids, posts, revisions, transactions],
    );
    await database.admin.query(
      `UPDATE content.thread AS thread SET first_post_id=item.post_id
         FROM unnest($2::uuid[], $3::uuid[]) AS item(thread_id, post_id)
        WHERE thread.route=$1 AND thread.thread_id=item.thread_id`,
      [contentRoute, ids, posts],
    );
    await database.admin.query(
      `INSERT INTO content.subject_thread
         (route, subject_id, thread_route, thread_id, place_id, kind, last_activity_at, source_epoch, source_position)
       SELECT $1, $2, $3, item.thread_id, $4, 'discussion', '2020-01-01T00:00:00Z', 1, item.ordinal
         FROM unnest($5::uuid[]) WITH ORDINALITY AS item(thread_id, ordinal)`,
      [subjectRoute, subjectId, contentRoute, realmId, ids],
    );
  } else if (axis === 'selected-history') {
    await database.admin.query(
      `INSERT INTO content.conversation_activity_episode
         (route, post_id, thread_id, opening, contributed_at, native_eligible, security_revision, source_epoch, source_position)
       SELECT $1, item.post_id, $2, false,
              CASE WHEN item.ordinal % 2 = 0 THEN item.ordinal * INTERVAL '1 second' END,
              item.ordinal % 2 = 0, 1, 1, item.ordinal
         FROM unnest($3::uuid[]) WITH ORDINALITY AS item(post_id, ordinal)`,
      [sourceRoute, selected.at(-1)!.id, population.historyPostIds.slice(0, scale)],
    );
  } else if (axis === 'account-authority') {
    await database.admin.query(
      `INSERT INTO access.resource_grant
         (route, resource_id, subject_id, subject_role, action, valid, transaction_id)
       SELECT $1, $2, item.subject_id, '', 'board:read', '[2020-01-01T00:00:00Z,2020-01-02T00:00:00Z)', item.transaction_id
         FROM unnest($3::uuid[], $4::uuid[]) AS item(subject_id, transaction_id)`,
      [routeOf(boardId), boardId, ids, transactions],
    );
  } else {
    await database.admin.query(
      `INSERT INTO content.conversation_activity_board_frontier
         (route, board_id, generation, source_epoch, source_position, source_event_seq, complete)
       SELECT $1, item.board_id, 1, 1, 1, 0, false
         FROM unnest($2::uuid[]) AS item(board_id)`,
      [sourceRoute, population.boardIds.slice(0, scale)],
    );
  }
  if (axis === 'unrelated-content')
    await database.admin.query('ANALYZE content.thread, content.post, content.revision, content.subject_thread');
  else if (axis === 'selected-history') await database.admin.query('ANALYZE content.conversation_activity_episode');
  else if (axis === 'account-authority') await database.admin.query('ANALYZE access.resource_grant');
  else await database.admin.query('ANALYZE content.conversation_activity_board_frontier');
}

async function clearPopulation(axis: Axis, population: Population): Promise<void> {
  if (axis === 'unrelated-content') {
    await database.admin.query('DELETE FROM content.subject_thread WHERE route=$1 AND thread_id=ANY($2::uuid[])', [
      subjectRoute,
      population.threadIds,
    ]);
    await database.admin.query('DELETE FROM content.revision WHERE route=$1 AND revision_id=ANY($2::uuid[])', [
      contentRoute,
      population.revisionIds,
    ]);
    await database.admin.query('DELETE FROM content.post WHERE route=$1 AND post_id=ANY($2::uuid[])', [
      contentRoute,
      population.postIds,
    ]);
    await database.admin.query('DELETE FROM content.thread WHERE route=$1 AND thread_id=ANY($2::uuid[])', [
      contentRoute,
      population.threadIds,
    ]);
    await database.admin.query('ANALYZE content.thread, content.post, content.revision, content.subject_thread');
  } else if (axis === 'selected-history') {
    await database.admin.query('DELETE FROM content.conversation_activity_episode WHERE route=$1 AND post_id=ANY($2::uuid[])', [
      sourceRoute,
      population.historyPostIds,
    ]);
    await database.admin.query('ANALYZE content.conversation_activity_episode');
  } else if (axis === 'account-authority') {
    await database.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND transaction_id=ANY($2::uuid[])', [
      routeOf(boardId),
      population.transactionIds,
    ]);
    await database.admin.query('ANALYZE access.resource_grant');
  } else {
    await database.admin.query(
      'DELETE FROM content.conversation_activity_board_frontier WHERE route=$1 AND board_id=ANY($2::uuid[])',
      [sourceRoute, population.boardIds],
    );
    await database.admin.query('ANALYZE content.conversation_activity_board_frontier');
  }
}

function planNodes(value: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
    } else if (typeof item === 'object' && item !== null) {
      const record = item as Record<string, unknown>;
      if (typeof record['Node Type'] === 'string') nodes.push(record);
      for (const child of Object.values(record)) visit(child);
    }
  };
  visit(value);
  return nodes;
}

function assertIndexedSnapshots(capture: Capture): void {
  const snapshotStatements = capture.statements.flatMap((sql, statement) =>
    /content\.conversation_activity_board_frontier/i.test(sql) ? [statement] : [],
  );
  expect(snapshotStatements.length).toBeGreaterThanOrEqual(4);
  const plans = capture.plans.flatMap((plan, index) => {
    const statement = capture.planStatements?.[index];
    return statement !== undefined && snapshotStatements.includes(statement) ? [planNodes(plan)] : [];
  });
  expect(plans.length).toBeGreaterThanOrEqual(4);
  for (const nodes of plans) {
    const indexedEpisode = nodes.some((node) => {
      const label = `${node['Relation Name'] ?? ''} ${node['Index Name'] ?? ''}`;
      const condition = String(node['Index Cond'] ?? '');
      return (
        label.includes('conversation_activity_episode') &&
        /Index/.test(String(node['Node Type'])) &&
        /route/i.test(condition) &&
        /thread_id/i.test(condition)
      );
    });
    expect(indexedEpisode, 'each selected and confirmed snapshot uses a full indexed thread key').toBe(true);
  }

  const subjectPageStatements = capture.statements.flatMap((sql, statement) =>
    /FROM\s+content\.subject_thread\b/i.test(sql) ? [statement] : [],
  );
  expect(subjectPageStatements.length).toBeGreaterThan(0);
  const subjectPlans = capture.plans.flatMap((plan, index) => {
    const statement = capture.planStatements?.[index];
    return statement !== undefined && subjectPageStatements.includes(statement) ? [planNodes(plan)] : [];
  });
  expect(subjectPlans.length).toBeGreaterThan(0);
  expect(
    subjectPlans.every((nodes) =>
      nodes.some((node) => {
        const condition = String(node['Index Cond'] ?? '');
        return (
          String(node['Relation Name'] ?? '').includes('subject_thread') &&
          /Index/.test(String(node['Node Type'])) &&
          /subject_id/i.test(condition) &&
          /place_id/i.test(condition)
        );
      }),
    ),
    'each complete Subject candidate page uses its selected subject and place index',
  ).toBe(true);
}

function assertBoundedGrowth(axis: Axis, samples: readonly Sample[]): void {
  expect(samples.map(({ scale }) => scale)).toEqual([...scales]);
  const first = samples[0]!;
  for (const sample of samples.slice(1)) {
    expect(sample.cost.statements, `${axis}: SQL statement count`).toBe(first.cost.statements);
    expect(sample.cost.controlStatements, `${axis}: transaction/control work`).toBe(first.cost.controlStatements);
    expect(sample.cost.catalogStatements, `${axis}: catalog work`).toBe(first.cost.catalogStatements);
    expect(sample.cost.requestBytes, `${axis}: pool request bytes`).toBe(first.cost.requestBytes);
    expect(sample.cost.responseBytes, `${axis}: pool response bytes`).toBe(first.cost.responseBytes);
    expect(sample.measurement.poolRequestBytes, `${axis}: pool request bytes in the complete page`).toBe(
      first.measurement.poolRequestBytes,
    );
    expect(sample.measurement.poolResponseBytes, `${axis}: pool response bytes in the complete page`).toBe(
      first.measurement.poolResponseBytes,
    );
    expect(sample.cost.rows, `${axis}: examined rows`).toBeLessThanOrEqual(first.cost.rows + 24);
    expect(sample.cost.blocks, `${axis}: examined blocks`).toBeLessThanOrEqual(first.cost.blocks + 36);
    expect(sample.cost.backgroundStatements ?? 0, `${axis}: background runner statements`).toBe(
      first.cost.backgroundStatements ?? 0,
    );
    expect(sample.cost.backgroundRows ?? 0, `${axis}: background runner rows`).toBe(first.cost.backgroundRows ?? 0);
    expect(sample.cost.backgroundBlocks ?? 0, `${axis}: background runner blocks`).toBe(
      first.cost.backgroundBlocks ?? 0,
    );
    expect(sample.measurement).toEqual(first.measurement);
    expect(sample.cost.relations['content.conversation_activity_episode']?.rows).toBe(
      first.cost.relations['content.conversation_activity_episode']?.rows,
    );
    expect(sample.cost.relations['content.subject_thread']?.rows).toBe(
      first.cost.relations['content.subject_thread']?.rows,
    );
  }
}

test.serial('complete Home and Subject conversation pages stay bounded across four independent histories', async () => {
  const home = await readHome();
  expect(home.value.feedItems).toHaveLength(pageSize);
  const homeThread = home.value.feedItems.find((item: any) => item.key?.id === selected.at(-1)!.id);
  expect(homeThread).toBeDefined();
  assertCurrentActivity(activityFor(homeThread), 2);

  const preview = await readSubject(5);
  expect(preview.value.threads).toHaveLength(5);
  expect(preview.value.next).toEqual(expect.any(String));
  const firstPage = await readSubject(pageSize);
  expect(firstPage.value.threads).toHaveLength(pageSize);
  expect(firstPage.value.next).toEqual(expect.any(String));
  const featured = firstPage.value.threads.find((entry: any) => entry.id === selected.at(-1)!.id);
  expect(featured?.card.comments).toMatchObject({
    state: 'current',
    cohort: 'public',
    count: { kind: 'exact', value: 2 },
    lastActivityAt: activityAt,
  });

  const sparseCursor = firstPage.value.next;
  staleThreadIds = await addSparseSubjectRows();
  const sparse = await readSubject(pageSize, sparseCursor);
  expect(sparse.value.threads).toHaveLength(15);
  expect(sparse.value.next).toEqual(expect.any(String));
  const final = await readSubject(pageSize, sparse.value.next);
  expect(final.value.threads).toHaveLength(5);
  expect(final.value.next).toBeNull();

  for (const axis of axes) {
    const population = makePopulation();
    const samples: Sample[] = [];
    try {
      for (const scale of scales) {
        await grow(axis, population, scale);
        const measured = await captureDatabase(
          database,
          () =>
            withJsonMeter(async (stringify) => {
            const homePage = await readHome();
            const subjectPage = await readSubject(pageSize);
            expect(homePage.value.feedItems).toHaveLength(pageSize);
            expect(subjectPage.value.threads).toHaveLength(pageSize);
            const expectedKeys = selected.slice(-pageSize).reverse().map(({ id }) => id);
            const homeThreadKeys = homePage.value.feedItems
              .filter((item: any) => item.source === 'following' && item.key?.owner === 'content')
              .map((item: any) => item.key.id);
            expect(homeThreadKeys).toEqual(expectedKeys);
            expect(subjectPage.value.threads.map((entry: any) => entry.id)).toEqual(expectedKeys);
            const currentHome = homePage.value.feedItems.find((item: any) => item.key?.id === selected.at(-1)!.id);
            const currentSubject = subjectPage.value.threads.find((entry: any) => entry.id === selected.at(-1)!.id);
            assertCurrentActivity(activityFor(currentHome), 2);
            expect(currentSubject?.card.comments).toMatchObject({
              state: 'current',
              cohort: 'public',
              count: { kind: 'exact', value: 2 },
              lastActivityAt: activityAt,
            });
            const homeRequestBytes = Buffer.byteLength(
              `GET https://content.test/v1/feedItems?stream=home&limit=20\nauthorization: Bearer ${world.base.other.bearer}\n`,
              'utf8',
            );
            const subjectPath =
              `/v1/subjects/${subjectId}/threads?` +
              new URLSearchParams({ place: realmId, kind: 'discussion', limit: String(pageSize) }).toString();
            const subjectRequestBytes = Buffer.byteLength(
              `GET https://content.test${subjectPath}\nauthorization: Bearer ${world.base.author.bearer}\n`,
              'utf8',
            );
            const homeResponseBytes = Buffer.byteLength(homePage.text, 'utf8');
            const subjectResponseBytes = Buffer.byteLength(subjectPage.text, 'utf8');
            const activityValues = {
              home: homePage.value.feedItems.map((item: any) => item.summary?.conversationActivity),
              subject: subjectPage.value.threads.map((entry: any) => entry.card?.comments),
            };
            const homeKeys = homePage.value.feedItems.map((item: any) => `${item.source}:${item.key?.id ?? item.id}`);
            const subjectKeys = subjectPage.value.threads.map((entry: any) => entry.id);
            const representedHomes = [
              ...new Set(
                [
                  ...homePage.value.feedItems
                    .filter((item: any) => item.key?.owner === 'content' && Number.isInteger(item.key.route))
                    .map((item: any) => partitionOf(item.key.route)),
                  ...subjectPage.value.threads
                    .map((entry: any) => routeOf(entry.id))
                    .filter((route: number | null): route is number => route !== null)
                    .map(partitionOf),
                ],
              ),
            ].sort((left, right) => left - right);
            expect(new Set(homeKeys).size).toBe(homeKeys.length);
            expect(new Set(subjectKeys).size).toBe(subjectKeys.length);
            expect(representedHomes).toEqual(representedHomePartitions);
            return {
              homePage,
              subjectPage,
              measurement: {
                homeRequestBytes,
                subjectRequestBytes,
                admittedBytes: homeRequestBytes + subjectRequestBytes + homeResponseBytes + subjectResponseBytes,
                retainedUtf8Bytes: utf8Json({ ids: selectedThreadIds, activityValues }, stringify),
                materializedUtf8Bytes: utf8Json(
                  { home: homePage.value.feedItems, subject: subjectPage.value.threads },
                  stringify,
                ),
                serializedUtf8Bytes: homeResponseBytes + subjectResponseBytes,
                snapshotReads: 0,
                poolQueries: 0,
                poolRequestBytes: 0,
                poolResponseBytes: 0,
                backendCount: 0,
                runnerQueries: 0,
                runnerRows: 0,
                runnerBlocks: 0,
                jsonStringifies: 0,
                jsonSerializedUtf8: 0,
                jsonParses: 0,
                jsonParsedUtf8: 0,
                homeKeys: stringify(homeKeys) ?? '',
                subjectKeys: stringify(subjectKeys) ?? '',
                representedHomes: stringify(representedHomes) ?? '',
              } satisfies PageMeasurement,
            };
            }),
          { includeBackends: true },
        );
        const cost = costOf(measured.capture);
        const snapshotReads = measured.capture.statements.filter((sql) =>
          /content\.conversation_activity_board_frontier/i.test(sql),
        ).length;
        const measurement: PageMeasurement = {
          ...measured.value.value.measurement,
          snapshotReads,
          poolQueries: measured.capture.statements.length,
          poolRequestBytes: cost.requestBytes,
          poolResponseBytes: cost.responseBytes,
          backendCount: new Set(measured.capture.statementBackends?.filter((pid) => pid !== undefined)).size,
          runnerQueries: measured.capture.backgroundStatements?.length ?? 0,
          runnerRows: cost.backgroundRows ?? 0,
          runnerBlocks: cost.backgroundBlocks ?? 0,
          jsonStringifies: measured.value.meter.stringifies,
          jsonSerializedUtf8: measured.value.meter.serializedUtf8,
          jsonParses: measured.value.meter.parses,
          jsonParsedUtf8: measured.value.meter.parsedUtf8,
        };
        expect(snapshotReads).toBeGreaterThanOrEqual(4);
        expect(measured.value.value.homePage.value.feedItems).toHaveLength(pageSize);
        expect(measured.value.value.subjectPage.value.threads).toHaveLength(pageSize);
        samples.push({ scale, capture: measured.capture, cost, measurement });
      }
      assertBoundedGrowth(axis, samples);
      assertIndexedSnapshots(samples.at(-1)!.capture);
    } finally {
      await clearPopulation(axis, population);
    }
  }
});
