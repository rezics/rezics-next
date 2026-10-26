import { afterAll, beforeAll, expect, test } from 'bun:test';
import { realmOfItem } from '../../src/content/realm-of-item.ts';
import { withConnection } from '../../src/database/pool.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { capture, checkGrowth, costOf, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';

const route = 0x1234;
const remoteRoute = 0x4321;
const createdAt = '2026-10-25T00:00:00Z';
const author = newId(route);
let db: GrowthDatabase;

type Item = {
  route: number;
  boardRoute: number;
  boardId: string;
  threadId: string;
  postId: string;
  realmId: string | null;
};
function item(boardRoute: number, realmId: string | null): Item {
  return { route, boardRoute, realmId, boardId: newId(boardRoute), threadId: newId(route), postId: newId(route) };
}
const local = item(route, newId(route));
const remote = item(remoteRoute, newId(remoteRoute));
const unbound = item(route, null);

function realmRows(boardRoute: number, realmId: string) {
  const spaceId = newId(boardRoute);
  const spaceRevision = newId(boardRoute);
  const realmRevision = newId(boardRoute);
  const common = { route: boardRoute, created_at: createdAt };
  const revision = { ...common, predecessor: null, title: 'Realm lookup fixture', summary: '', author };
  const realm = { route: boardRoute, realm_id: realmId, visibility: 'public', context_id: newId(boardRoute) };
  return {
    'community.space': [
      { ...common, space_id: spaceId, state: 'active', head_revision_id: spaceRevision, creator: author },
    ],
    'community.space_revision': [{ ...revision, space_id: spaceId, revision_id: spaceRevision }],
    'community.realm': [
      { ...common, ...realm, space_id: spaceId, state: 'active', head_revision_id: realmRevision, creator: author },
    ],
    'community.realm_revision': [{ ...revision, ...realm, revision_id: realmRevision }],
  };
}

function contentRows(anchor: Item) {
  const revisionId = newId(route);
  const common = {
    route,
    visibility: 'published',
    security_revision: 1,
    recorded_transaction_id: newId(route),
    created_at: createdAt,
  };
  return {
    'content.board': [
      {
        ...common,
        route: anchor.boardRoute,
        board_id: anchor.boardId,
        realm_id: anchor.realmId,
        subject_id: newId(anchor.boardRoute),
        title: 'Lookup board',
      },
    ],
    'content.thread': [
      {
        ...common,
        thread_id: anchor.threadId,
        board_id: anchor.boardId,
        author_account_id: author,
        first_post_id: anchor.postId,
        title: 'Lookup thread',
      },
    ],
    'content.post': [
      {
        ...common,
        thread_id: anchor.threadId,
        post_id: anchor.postId,
        head_revision_id: revisionId,
        author_account_id: author,
      },
    ],
    'content.revision': [
      {
        route,
        thread_id: anchor.threadId,
        post_id: anchor.postId,
        revision_id: revisionId,
        board_id: anchor.boardId,
        availability: 'erased',
        body: null,
        body_sha256: null,
        licence: 'MIT',
        subject_ids: [],
        recorded_transaction_id: common.recorded_transaction_id,
      },
    ],
  };
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  for (const anchor of [local, remote, unbound]) {
    await seed(
      db,
      {
        name: `realm-lookup-anchor-${anchor.boardId}`,
        hotPartition: partitionOf(route),
        hotShare: 1,
        rows: () => ({
          ...(anchor.realmId ? realmRows(anchor.boardRoute, anchor.realmId) : {}),
          ...contentRows(anchor),
        }),
      },
      { from: 0, to: 1 },
    );
  }
});
afterAll(async () => {
  await db?.close();
});

function resolve(kind: 'thread' | 'post', anchor: Item) {
  return withConnection(db.pool, (client) =>
    realmOfItem(client, kind, anchor.route, kind === 'thread' ? anchor.threadId : anchor.postId),
  );
}

test('thread and post Realm lookups use ordered, anchored point reads without joins', async () => {
  for (const kind of ['thread', 'post'] as const) {
    const measured = await capture(db, () => resolve(kind, local));
    expect(measured.value).toBe(local.realmId);
    const tables = kind === 'thread' ? ['thread', 'board'] : ['post', 'thread', 'board'];
    expect(measured.capture.statements).toHaveLength(tables.length);
    for (const [index, table] of tables.entries()) {
      const sql = measured.capture.statements[index]!;
      expect(sql).toMatch(
        new RegExp(`FROM content\\.${table}\\s+WHERE route = \\$1::integer AND ${table}_id = \\$2::uuid`),
      );
      expect(sql).not.toMatch(/\b(?:JOIN|FOR UPDATE|FOR SHARE)\b/i);
    }
  }
});

test("a thread and post on a board in another partition resolve to that board's Realm", async () => {
  expect(partitionOf(remote.boardRoute)).not.toBe(partitionOf(remote.route));
  for (const kind of ['thread', 'post'] as const) expect(await resolve(kind, remote)).toBe(remote.realmId);
});

test('unknown threads and posts and boards without a Realm resolve to no Realm', async () => {
  for (const kind of ['thread', 'post'] as const) {
    const measured = await capture(db, () =>
      withConnection(db.pool, (client) => realmOfItem(client, kind, route, newId(route))),
    );
    expect(measured.value).toBeNull();
    expect(costOf(measured.capture).statements).toBe(1);
    expect(await resolve(kind, unbound)).toBeNull();
  }
});

test('Realm lookup statements and rows stay constant as same-partition boards, threads and posts grow', async () => {
  const report = await checkGrowth(db, {
    name: 'Realm of a thread and a post',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      // The neighbours occupy the same two partitions as both measured chains.
      await seed(
        database,
        {
          name: 'realm-lookup-neighbours',
          hotPartition: partitionOf(route),
          hotShare: 1,
          rows: () => contentRows(item(remoteRoute, remote.realmId)),
        },
        { from: previous, to: scale },
      );
    },
    async operation() {
      expect(await resolve('thread', remote)).toBe(remote.realmId);
      expect(await resolve('post', remote)).toBe(remote.realmId);
    },
  });
  for (const { cost } of report.samples) {
    // Two point reads for the thread, three for the post.
    expect(cost.statements).toBe(5);
    expect(cost.rows).toBe(5);
    expect(Object.keys(cost.relations).sort()).toEqual(['content.board', 'content.post', 'content.thread']);
    expect(cost.relations['content.board']?.rows).toBe(2);
    expect(cost.relations['content.thread']?.rows).toBe(2);
    expect(cost.relations['content.post']?.rows).toBe(1);
    for (const relation of Object.values(cost.relations)) expect(relation.sequentialScans).toBe(0);
  }
  console.info(JSON.stringify(report));
}, 120_000);
