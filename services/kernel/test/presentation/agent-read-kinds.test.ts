import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import type { Pool } from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const accounts = { editor: '019a1b2c-3d4e-7f00-8a00-ed170e000001' };
const routeKey = new Uint8Array(32).fill(7);
const body = Buffer.from(JSON.stringify(fromPlainText('Agent profile reply')));
const bodyHash = new Uint8Array(new Bun.CryptoHasher('sha256').update(body).digest());
const contentRoute = 0x1234;
const boardRoute = 0x4321;
const handleRoute = (handle: string) => createHash('sha256').update(handle).digest().readUInt16BE(0);

type Account = { id: string; handle: string };
type AgentItemKind = 'discussion' | 'review';
type AgentItem = {
  threadId: string;
  openingPostId: string;
  replyId: string;
  boardId: string;
  kind: AgentItemKind;
  createdAt: string;
};

let growth: GrowthDatabase;
let pool: Pool;
let admin: Pool;
let realAccess: Awaited<ReturnType<typeof createRealAccess<typeof accounts>>>;
let kernel: ReturnType<typeof createKernel>;
let pageAccount: Account;
let threadGrowthAccount: Account;
let postGrowthAccount: Account;
let collectionGrowthAccount: Account;
let identityGrowthAccount: Account;
let profile: PresentationProfile;

const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const document = (...content: ReturnType<typeof node>[]) => ({ root: { props: {} }, content });

async function ensureAccount(handle: string, displayName = 'Public agent'): Promise<Account> {
  const route = 0x5210;
  const id = newId(route);
  await admin.query(
    `INSERT INTO access.account
       (route,account_id,kind,state,handle,display_name,biography,links,transaction_id)
     VALUES ($1,$2,'actor','active',$3,$4,'A public agent biography','[{"label":"Site","url":"https://example.test"}]'::jsonb,$2)`,
    [route, id, handle, displayName],
  );
  await admin.query(
    `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id)
     VALUES ($1,$2,$3,'active',$3)`,
    [handleRoute(handle), handle, id],
  );
  return { id, handle };
}

function accountNodes(handle: string, includeCollections = true) {
  return [
    node('AccountIdentity', 'identity', { handle }),
    node('AccountThreads', 'discussions', { threadKind: 'discussion', limit: 1 }),
    node('AccountThreads', 'reviews', { threadKind: 'review', limit: 1 }),
    node('AccountPosts', 'posts', { limit: 1 }),
    ...(includeCollections ? [node('AccountCollections', 'collections', { limit: 1 })] : []),
  ];
}

function itemsFor(
  authorId: string,
  ordinal: number,
  kind: AgentItemKind,
  reply = true,
): {
  item: AgentItem;
  rows: Readonly<Record<string, readonly Record<string, unknown>[]>>;
} {
  const home = kind === 'review' ? routeOf(authorId)! : contentRoute;
  const threadId = newId(home);
  const openingPostId = newId(home);
  const replyId = newId(home);
  const boardId = kind === 'review' ? '00000000-0000-8000-8000-000000000001' : newId(boardRoute);
  const subjectId = newId(kind === 'review' ? home : boardRoute);
  const createdAt = new Date(Date.UTC(2026, 9, 1) + ordinal * 1_000).toISOString();
  const common = {
    route: home,
    visibility: 'published',
    security_revision: 1,
    created_at: createdAt,
    recorded_transaction_id: threadId,
  };
  const postIds = reply ? [openingPostId, replyId] : [openingPostId];
  const posts = postIds.map((postId) => ({
    ...common,
    thread_id: threadId,
    post_id: postId,
    author_account_id: authorId,
    head_revision_id: newId(home),
  }));
  const authorItems = [
    {
      route: routeOf(authorId),
      author_account_id: authorId,
      item_kind: 'thread',
      item_id: threadId,
      thread_id: threadId,
      thread_kind: kind,
      created_at: createdAt,
      source_epoch: 1,
      source_position: ordinal * 2 + 1,
    },
    ...(reply
      ? [
          {
            route: routeOf(authorId),
            author_account_id: authorId,
            item_kind: 'post',
            item_id: replyId,
            thread_id: threadId,
            thread_kind: kind,
            created_at: createdAt,
            source_epoch: 1,
            source_position: ordinal * 2 + 2,
          },
        ]
      : []),
  ];
  return {
    item: { threadId, openingPostId, replyId, boardId, kind, createdAt },
    rows: {
      'content.board':
        kind === 'review'
          ? []
          : [
              {
                ...common,
                route: boardRoute,
                board_id: boardId,
                subject_id: subjectId,
                realm_id: null,
                title: 'Agent discussion board',
                purpose: 'discussion',
              },
            ],
      'content.thread': [
        {
          ...common,
          thread_id: threadId,
          author_account_id: authorId,
          board_id: boardId,
          first_post_id: openingPostId,
          title: `${kind} ${ordinal}`,
          kind,
          review_subject_id: kind === 'review' ? subjectId : null,
        },
      ],
      'content.post': posts,
      'content.revision': posts.map((post) => ({
        route: home,
        thread_id: threadId,
        post_id: post.post_id,
        revision_id: post.head_revision_id,
        body,
        body_sha256: bodyHash,
        search_text: 'Agent profile reply',
        licence: 'MIT',
        subject_ids: kind === 'review' && post.post_id === openingPostId ? [subjectId] : [],
        board_id: boardId,
        availability: 'available',
        recorded_transaction_id: threadId,
      })),
      'content.author_item': authorItems,
    },
  };
}

async function seedAgentItems(
  authorId: string,
  values: readonly { kind: AgentItemKind; reply?: boolean }[],
  name: string,
) {
  const records = values.map(({ kind, reply = true }, ordinal) => itemsFor(authorId, ordinal, kind, reply).rows);
  const population: Population = {
    name,
    hotPartition: contentRoute >>> 4,
    rows: ({ ordinal }) => records[ordinal]!,
  };
  await seed(growth, population, { from: 0, to: values.length });
}

async function seedAgentCollections(accountId: string, count: number, start: number): Promise<void> {
  const route = routeOf(accountId)!;
  const collectionIds = Array.from({ length: count }, () => newId(route));
  await admin.query(
    `INSERT INTO library.collection
       (route,collection_id,curator_account_id,title,visibility,state,revision,member_count,
        order_epoch,created_at,updated_at,transaction_id)
     SELECT $1,collection_id,$2,'Agent collection','public','active',1,0,0,
            now() + (ordinal * interval '1 millisecond'),now() + (ordinal * interval '1 millisecond'),collection_id
     FROM unnest($3::uuid[]) WITH ORDINALITY AS rows(collection_id,ordinal)`,
    [route, accountId, collectionIds],
  );
  void start;
}

async function call(method: string, path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

async function readPage(route: string) {
  return call('POST', '/v1/pages:read', { target: { route } });
}

async function getJson(path: string): Promise<Record<string, any>> {
  const { response, body } = await call('GET', path);
  if (response.status !== 200) throw new Error(`GET ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function assertConstantStatements(samples: readonly { cost: { statements: number } }[]): void {
  expect(new Set(samples.map(({ cost }) => cost.statements)).size).toBe(1);
}

beforeAll(async () => {
  growth = await openGrowthDatabase(url);
  pool = growth.pool;
  admin = growth.admin;
  realAccess = await createRealAccess(admin, accounts, ['subject:create']);
  kernel = createKernel({
    pool,
    routeKey,
    access: realAccess.access,
    writeRate: realAccess.writeRate,
    requestDeadlineMs: 30_000,
  });
  await bootstrapRelease(pool, bundledRelease);
  await admin.query(
    `INSERT INTO access.exposure_opening (route,"group",valid,transaction_id)
     VALUES (0,'collections',tstzrange(now()-interval '1 day',NULL,'[)'),$1)`,
    [randomUUID()],
  );

  pageAccount = await ensureAccount(`agent_${randomUUID().replaceAll('-', '')}`, 'Page agent');
  threadGrowthAccount = await ensureAccount(`threads_${randomUUID().replaceAll('-', '')}`);
  postGrowthAccount = await ensureAccount(`posts_${randomUUID().replaceAll('-', '')}`);
  collectionGrowthAccount = await ensureAccount(`collections_${randomUUID().replaceAll('-', '')}`);
  identityGrowthAccount = await ensureAccount(`identity_${randomUUID().replaceAll('-', '')}`);

  await seedAgentItems(
    pageAccount.id,
    [{ kind: 'discussion' }, { kind: 'discussion' }, { kind: 'review' }, { kind: 'review' }],
    `agent-page-${randomUUID()}`,
  );
  await seedAgentCollections(pageAccount.id, 2, 0);

  const missingHandle = `missing_${randomUUID().replaceAll('-', '')}`;
  profile = {
    format: PROFILE_FORMAT,
    generic: document(node('Heading', 'generic', { text: 'Agent', level: 1 })),
    bases: [],
    types: [],
    routes: [
      { route: '/agent', document: document(...accountNodes(pageAccount.handle)) },
      { route: '/missing', document: document(...accountNodes(missingHandle)) },
    ],
  };
  await bootstrapProfile(pool, profile);
});

afterAll(async () => {
  await growth?.close();
});

test.serial(
  'a page read plans and answers an account by handle, and an unknown handle answers an empty result',
  async () => {
    const answer = await readPage('/agent');
    expect(answer.response.status).toBe(200);
    expect(answer.body.profile).toBe(profileDigest(profile));
    expect(Object.keys(answer.body.reads)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    const accountRead = answer.body.reads.r0;
    expect(accountRead.status).toBe(200);
    expect(accountRead.body.accounts).toHaveLength(1);
    expect(accountRead.body.accounts[0]).toMatchObject({
      id: pageAccount.id,
      handle: pageAccount.handle,
      displayName: 'Page agent',
      state: 'active',
      bio: 'A public agent biography',
      links: [{ label: 'Site', url: 'https://example.test' }],
      avatar: null,
      publicViews: { posts: true, reviews: true, collections: true },
    });

    const unknown = await readPage('/missing');
    expect(unknown.response.status).toBe(200);
    expect(unknown.body.reads).toEqual({ r0: { status: 200, body: { accounts: [], next: null } } });
  },
);

test.serial(
  "a page read answers an account's discussions, reviews and replies as bounded pages with continuations",
  async () => {
    const answer = await readPage('/agent');
    expect(answer.response.status).toBe(200);
    const discussions = await getJson(`/v1/accounts/${pageAccount.id}/threads?kind=discussion&limit=1`);
    const reviews = await getJson(`/v1/accounts/${pageAccount.id}/threads?kind=review&limit=1`);
    const posts = await getJson(`/v1/accounts/${pageAccount.id}/posts?limit=1`);
    expect(answer.body.reads.r1.body).toEqual(discussions);
    expect(answer.body.reads.r2.body).toEqual(reviews);
    expect(answer.body.reads.r3.body).toEqual(posts);
    expect(discussions.threads).toHaveLength(1);
    expect(discussions.next).toBeString();
    expect(reviews.threads).toHaveLength(1);
    expect(reviews.next).toBeString();
    expect(posts.posts).toHaveLength(1);
    expect(posts.posts[0].thread).toHaveProperty('id');
    expect(posts.posts[0].thread).toHaveProperty('title');
    expect(posts.next).toBeString();
  },
);

test.serial(
  "a page read answers an account's public collections as a bounded BASIC page with a continuation",
  async () => {
    const answer = await readPage('/agent');
    expect(answer.response.status).toBe(200);
    const collections = await getJson(`/v1/accounts/${pageAccount.id}/collections?view=BASIC&limit=1`);
    expect(answer.body.reads.r4.body).toEqual(collections);
    expect(collections.collections).toHaveLength(1);
    expect(collections.next).toBeString();
  },
);

test.serial('account identity read stays within its bound at 1, 10 and 100 unrelated accounts', async () => {
  const report = await checkGrowth(growth, {
    name: 'Account identity page read',
    scales: [1, 10, 100],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(database, scale, previous) {
      const values = Array.from({ length: scale - previous }, () => {
        const id = newId(0x6041);
        const handle = `unrelated_${randomUUID().replaceAll('-', '')}`;
        return { id, handle, handleRoute: handleRoute(handle) };
      });
      for (const value of values) {
        await database.admin.query(
          `INSERT INTO access.account(route,account_id,kind,state,handle,transaction_id)
           VALUES ($1,$2,'actor','active',$3,$2)`,
          [routeOf(value.id), value.id, value.handle],
        );
        await database.admin.query(
          `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id)
           VALUES ($1,$2,$3,'active',$3)`,
          [value.handleRoute, value.handle, value.id],
        );
      }
    },
    async operation() {
      const value = await getJson(`/v1/accounts?handle=${identityGrowthAccount.handle}`);
      expect(value.accounts).toHaveLength(1);
      expect(value.accounts[0].id).toBe(identityGrowthAccount.id);
      return value;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 10, 100]);
  assertConstantStatements(report.samples);
  expect(report.samples.every(({ cost }) => (cost.relations['access.handle_claim']?.rows ?? 0) <= 1)).toBe(true);
  expect(report.samples.every(({ cost }) => (cost.relations['access.account']?.rows ?? 0) <= 1)).toBe(true);
});

test.serial('account discussions read stays within its bound at 1, 10 and 100 threads', async () => {
  const report = await checkGrowth(growth, {
    name: 'Account discussions page read',
    scales: [1, 10, 100],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(_database, scale, previous) {
      await seedAgentItems(
        threadGrowthAccount.id,
        Array.from({ length: scale - previous }, () => ({ kind: 'discussion' as const })),
        'account-thread-growth',
      );
    },
    async operation(_database, scale) {
      const value = await getJson(`/v1/accounts/${threadGrowthAccount.id}/threads?kind=discussion&limit=1`);
      expect(value.threads).toHaveLength(1);
      if (scale > 1) expect(value.next).toBeString();
      return value;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 10, 100]);
  assertConstantStatements(report.samples);
  expect(report.samples.every(({ cost }) => (cost.relations['content.author_item']?.rows ?? 0) <= 4)).toBe(true);
  expect(report.samples.every(({ cost }) => (cost.relations['content.thread']?.rows ?? 0) <= 2)).toBe(true);
});

test.serial('account replies read stays within its bound at 1, 10 and 100 replies', async () => {
  const report = await checkGrowth(growth, {
    name: 'Account replies page read',
    scales: [1, 10, 100],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(_database, scale, previous) {
      await seedAgentItems(
        postGrowthAccount.id,
        Array.from({ length: scale - previous }, () => ({ kind: 'discussion' as const })),
        'account-post-growth',
      );
    },
    async operation(_database, scale) {
      const value = await getJson(`/v1/accounts/${postGrowthAccount.id}/posts?limit=1`);
      expect(value.posts).toHaveLength(1);
      expect(value.posts[0].thread).toHaveProperty('id');
      expect(value.posts[0].thread).toHaveProperty('title');
      if (scale > 1) expect(value.next).toBeString();
      return value;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 10, 100]);
  assertConstantStatements(report.samples);
  expect(report.samples.every(({ cost }) => (cost.relations['content.author_item']?.rows ?? 0) <= 4)).toBe(true);
  expect(report.samples.every(({ cost }) => (cost.relations['content.thread']?.rows ?? 0) <= 2)).toBe(true);
  expect(report.samples.every(({ cost }) => (cost.relations['content.post']?.rows ?? 0) <= 2)).toBe(true);
});

test.serial('account collections read stays within its bound at 1, 10 and 100 collections', async () => {
  const report = await checkGrowth(growth, {
    name: 'Account public collections page read',
    scales: [1, 10, 100],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(_database, scale, previous) {
      await seedAgentCollections(collectionGrowthAccount.id, scale - previous, previous);
    },
    async operation(_database, scale) {
      const value = await getJson(`/v1/accounts/${collectionGrowthAccount.id}/collections?view=BASIC&limit=1`);
      expect(value.collections).toHaveLength(1);
      if (scale > 1) expect(value.next).toBeString();
      return value;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 10, 100]);
  assertConstantStatements(report.samples);
  expect(report.samples.every(({ cost }) => (cost.relations['library.collection']?.rows ?? 0) <= 1)).toBe(true);
});
