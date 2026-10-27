import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, capture, costOf, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

const authorRoute = 0x9abc;
const contentRoute = 0x1234;
const boardRoute = 0x4321;
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let app: ReturnType<typeof createKernel>;
let bearer: string;

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  const keys = await generateKeyPair('ES256');
  const publicKey = { ...(await exportJWK(keys.publicKey)), kid: 'profile', alg: 'ES256' };
  const issuer = 'https://auth.test';
  const audience = 'https://kernel.test';
  app = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(7),
    tokens,
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/jwks`,
          fetch: async () => Response.json({ keys: [publicKey] }),
        },
      }),
  });
  app.compile();
  // The kernel wraps fetch; finish eager router compilation outside request deadlines.
  const fetchGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(app), 'fetch')?.get;
  if (!fetchGetter) throw new Error('Elysia fetch getter is unavailable');
  fetchGetter.call(app);
  const viewer = newId(authorRoute);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    VALUES ($1,$2,'actor','active',$2)`,
    [authorRoute, viewer],
  );
  bearer = await new SignJWT({
    client_id: 'web',
    scope: 'thread:read post:read board:read realm:read',
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'profile', typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(viewer)
    .setIssuedAt()
    .setExpirationTime('3m')
    .sign(keys.privateKey);
});
afterAll(async () => {
  await db?.close();
});

const body = Buffer.from(JSON.stringify(fromPlainText('Profile reply')));
async function ensureAuthor(author: string) {
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,membership_inverse_complete,transaction_id)
    VALUES ($1,$2,'actor','active',true,$2) ON CONFLICT (route,account_id) DO NOTHING`,
    [routeOf(author), author],
  );
}

function rows(
  author: string,
  at: string,
  kind: 'discussion' | 'review' = 'discussion',
  reply = false,
  realmId: string | null = null,
) {
  const home = kind === 'review' ? routeOf(author)! : contentRoute;
  const target = newId(home);
  const thread = newId(home),
    opening = newId(home),
    post = reply ? newId(home) : opening;
  const board = kind === 'review' ? '00000000-0000-8000-8000-000000000001' : newId(boardRoute);
  const common = {
    route: home,
    visibility: 'published',
    security_revision: 1,
    created_at: at,
    recorded_transaction_id: thread,
  };
  const posts = [...new Set([opening, post])].map((id) => ({
    ...common,
    thread_id: thread,
    post_id: id,
    author_account_id: author,
    head_revision_id: newId(home),
  }));
  return {
    ids: { thread, opening, post, board },
    records: {
      'content.board':
        kind === 'review'
          ? []
          : [
              {
                ...common,
                route: boardRoute,
                board_id: board,
                subject_id: newId(boardRoute),
                realm_id: realmId,
                title: 'Profile board',
                purpose: 'discussion',
              },
            ],
      'content.thread': [
        {
          ...common,
          thread_id: thread,
          author_account_id: author,
          board_id: board,
          first_post_id: opening,
          title: 'Profile thread',
          kind,
          review_subject_id: kind === 'review' ? target : null,
        },
      ],
      'content.post': posts,
      'content.revision': posts.map((p) => ({
        route: home,
        thread_id: thread,
        post_id: p.post_id,
        revision_id: p.head_revision_id,
        body,
        body_sha256: new Uint8Array(new Bun.CryptoHasher('sha256').update(body).digest()),
        search_text: 'Profile reply',
        licence: 'MIT',
        subject_ids: kind === 'review' && p.post_id === opening ? [target] : [],
        board_id: board,
        availability: 'available',
        recorded_transaction_id: thread,
      })),
      'content.author_item': [
        {
          route: routeOf(author),
          author_account_id: author,
          item_kind: reply ? 'post' : 'thread',
          item_id: reply ? post : thread,
          thread_id: thread,
          thread_kind: kind,
          created_at: at,
          source_epoch: 1,
          source_position: 1,
        },
      ],
    },
  };
}
async function fixture(
  author: string,
  at: string,
  kind: 'discussion' | 'review' = 'discussion',
  reply = false,
  realmId: string | null = null,
) {
  await ensureAuthor(author);
  const value = rows(author, at, kind, reply, realmId);
  await seed(
    db,
    { name: crypto.randomUUID(), hotPartition: contentRoute >>> 4, rows: () => value.records },
    { from: 0, to: 1 },
  );
  return value.ids;
}
function path(author: string, list = 'threads', query: Record<string, string> = {}) {
  return `/v1/accounts/${author}/${list}?${new URLSearchParams(query)}`;
}
async function get(url: string, token?: string) {
  const response = await app.handle(
    new Request(`http://kernel.test${url}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );
  return { status: response.status, body: await response.json() };
}

function planNodes(value: unknown, nodes: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const child of value) planNodes(child, nodes);
  } else if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    if (typeof object['Node Type'] === 'string') nodes.push(object);
    for (const child of Object.values(object)) planNodes(child, nodes);
  }
  return nodes;
}

function growthId(route: number, prefix: string, ordinal: number): string {
  return `${prefix}-0000-7000-8000-${route.toString(16).padStart(4, '0')}${ordinal.toString(16).padStart(8, '0')}`;
}

function otherAuthorItems(reply: boolean, prefix: string): Population {
  return {
    name: `author-item-growth-${prefix}-${reply ? 'posts' : 'threads'}`,
    hotPartition: authorRoute >>> 4,
    hotShare: 1,
    rows: ({ ordinal }) => {
      const key = ordinal + 1;
      const threadId = growthId(contentRoute, `${prefix}00`, key);
      const itemId = reply ? growthId(contentRoute, `${prefix}01`, key) : threadId;
      return {
        'content.author_item': [
          {
            route: authorRoute,
            author_account_id: growthId(authorRoute, `${prefix}02`, key),
            item_kind: reply ? 'post' : 'thread',
            item_id: itemId,
            thread_id: threadId,
            thread_kind: 'discussion',
            created_at: new Date(Date.UTC(2026, 0, 1) + ordinal * 1000).toISOString(),
            source_epoch: 1,
            source_position: key,
          },
        ],
      };
    },
  };
}

function expectAuthorPageIndex(plans: readonly unknown[], index: string): void {
  const scans = planNodes(plans).filter(
    (node) =>
      node.Schema === 'content' &&
      node['Relation Name'] === 'author_item' &&
      node['Index Name'] === index &&
      /Index (?:Only )?Scan/.test(String(node['Node Type'])),
  );
  expect(scans.length).toBeGreaterThan(0);
}
async function invalid(url: string, token?: string) {
  const result = await get(url, token);
  expect(result.status).toBe(400);
  expect(result.body).toMatchObject({ code: 'invalid_request' });
}

test('author routes return board summaries and reply entries newest first with signed bound cursors', async () => {
  expect(await get(path(newId(authorRoute)))).toEqual({ status: 200, body: { threads: [], next: null } });
  const author = newId(authorRoute);
  const old = await fixture(author, '2026-10-20T00:00:00.000001Z');
  const top = await fixture(author, '2026-10-20T00:00:00.000002Z');
  const tie = await fixture(author, '2026-10-20T00:00:00.000002Z');
  const review = await fixture(author, '2026-10-21T00:00:00Z', 'review');
  const ordered = [top.thread, tie.thread].sort().concat(old.thread);
  let cursor: string | undefined;
  for (const id of ordered) {
    const page = await get(path(author, 'threads', { limit: '1', ...(cursor ? { cursor } : {}) }));
    expect(page.status).toBe(200);
    expect(page.body.threads.map((t: { id: string }) => t.id)).toEqual([id]);
    expect(page.body.threads[0]).toMatchObject({
      title: 'Profile thread',
      kind: 'discussion',
      firstPost: { availability: 'available' },
    });
    cursor = page.body.next ?? undefined;
  }
  const first = await get(path(author, 'threads', { limit: '1' }));
  for (const url of [
    path(author, 'threads', { kind: 'review', cursor: first.body.next }),
    path(newId(authorRoute), 'threads', { cursor: first.body.next }),
    path(author, 'posts', { cursor: first.body.next }),
    path(author, 'threads', { cursor: `${first.body.next}x` }),
  ])
    await invalid(url);
  await invalid(path(author, 'threads', { cursor: first.body.next }), bearer);
  expect(
    (await get(path(author, 'threads', { kind: 'review' }))).body.threads.map((t: { id: string }) => t.id),
  ).toEqual([review.thread]);
  for (const query of [{ limit: '0' }, { limit: '21' }, { limit: '1.5' }, { kind: 'other' }])
    await invalid(path(author, 'threads', query));
  for (const query of [{ limit: '0' }, { limit: '21' }, { limit: '1.5' }]) await invalid(path(author, 'posts', query));
  const reply = await fixture(author, '2026-10-22T00:00:00Z', 'discussion', true);
  const reviewReply = await fixture(author, '2026-10-23T00:00:00Z', 'review', true);
  const replies = await get(path(author, 'posts'));
  expect(replies.status).toBe(200);
  expect(replies.body.posts.map((p: { id: string }) => p.id)).toEqual([reviewReply.post, reply.post]);
  expect(replies.body.posts[0]).toMatchObject({
    thread: { id: reviewReply.thread, title: 'Profile thread' },
    body: JSON.parse(body.toString('utf8')),
  });
  const postPage = await get(path(author, 'posts', { limit: '1' }));
  expect(
    (await get(path(author, 'posts', { limit: '1', cursor: postPage.body.next }))).body.posts.map(
      (p: { id: string }) => p.id,
    ),
  ).toEqual([reply.post]);
  for (const list of ['threads', 'posts']) {
    const page = await get(path(newId(authorRoute), list));
    expect(page).toEqual({ status: 200, body: { [list]: [], next: null } });
    expect(openApiDocument(app).paths[`/v1/accounts/{accountId}/${list}`]?.get).toBeDefined();
  }
  await db.admin.query(
    "UPDATE content.post SET availability='erased',security_revision=2 WHERE route=$1 AND post_id=$2",
    [contentRoute, reply.opening],
  );
  const erasedOpening = await get(path(author, 'posts'));
  expect(erasedOpening.body.posts.find((p: { id: string }) => p.id === reply.post).thread).toEqual({
    id: reply.thread,
    title: null,
  });
  const partition = authorRoute >>> 4;
  await db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [partition]);
  await invalid(path(author, 'threads', { cursor: first.body.next }));
});

test('author pages conceal protected Realms, drafts, takedowns and erasure with a four-limit scan cap', async () => {
  const author = newId(authorRoute);
  const realm = newId(boardRoute),
    space = newId(boardRoute),
    sr = newId(boardRoute),
    rr = newId(boardRoute),
    contextId = newId(boardRoute);
  await seed(
    db,
    {
      name: crypto.randomUUID(),
      hotPartition: boardRoute >>> 4,
      rows: () => ({
        'community.space': [
          {
            route: boardRoute,
            created_at: '2026-10-20T00:00:00Z',
            space_id: space,
            state: 'active',
            head_revision_id: sr,
            creator: author,
          },
        ],
        'community.space_revision': [
          {
            route: boardRoute,
            created_at: '2026-10-20T00:00:00Z',
            space_id: space,
            revision_id: sr,
            predecessor: null,
            title: 'Space',
            summary: '',
            author,
          },
        ],
        'community.realm': [
          {
            route: boardRoute,
            created_at: '2026-10-20T00:00:00Z',
            realm_id: realm,
            space_id: space,
            state: 'active',
            head_revision_id: rr,
            creator: author,
            visibility: 'protected',
            context_id: contextId,
          },
        ],
        'community.realm_revision': [
          {
            route: boardRoute,
            created_at: '2026-10-20T00:00:00Z',
            realm_id: realm,
            revision_id: rr,
            predecessor: null,
            title: 'Protected',
            summary: '',
            author,
            visibility: 'protected',
            context_id: contextId,
          },
        ],
      }),
    },
    { from: 0, to: 1 },
  );
  for (const reply of [false, true]) {
    const list = reply ? 'posts' : 'threads';
    const hidden: string[] = [];
    for (let i = 0; i < 4; i++) {
      const item = await fixture(author, `2026-10-2${6 - i}T00:00:00Z`, 'discussion', reply, i === 0 ? realm : null);
      hidden.push(reply ? item.post : item.thread);
      if (i === 1)
        await db.admin.query(
          "UPDATE content.thread SET visibility='taken_down',security_revision=2 WHERE route=$1 AND thread_id=$2",
          [contentRoute, item.thread],
        );
      if (i === 2)
        await db.admin.query(
          "UPDATE content.post SET visibility='draft',security_revision=2 WHERE route=$1 AND post_id=$2",
          [contentRoute, item.post],
        );
      if (i === 3)
        await db.admin.query(
          "UPDATE content.post SET availability='erased',security_revision=2 WHERE route=$1 AND post_id=$2",
          [contentRoute, item.post],
        );
    }
    const visible = await fixture(author, '2026-10-20T00:00:00Z', 'discussion', reply);
    for (const token of [undefined, bearer]) {
      const measured = await capture(db, () => get(path(author, list, { limit: '1' }), token));
      expect(measured.value.status).toBe(200);
      expect(measured.value.body[list]).toEqual([]);
      expect(measured.value.body.next).toEqual(expect.any(String));
      for (const id of hidden) {
        expect(JSON.stringify(measured.value.body)).not.toContain(id);
        expect(Buffer.from(measured.value.body.next.split('.')[0], 'base64url').toString('utf8')).not.toContain(id);
      }
      expect(costOf(measured.capture).relations['content.author_item']?.rows).toBeLessThanOrEqual(4);
      const next = await get(path(author, list, { limit: '1', cursor: measured.value.body.next }), token);
      expect(next.body[list].map((v: { id: string }) => v.id)).toEqual([reply ? visible.post : visible.thread]);
    }
  }
});

test('author pages set no planner method settings and read content.author_item through its keyset index', async () => {
  const captures: { capture: Awaited<ReturnType<typeof capture>>['capture']; index: string }[] = [];
  for (const reply of [false, true]) {
    const author = newId(authorRoute);
    const kind = reply ? 'posts' : 'threads';
    await fixture(author, '2026-10-20T00:00:00Z', 'discussion', reply);
    await fixture(author, '2026-10-21T00:00:00Z', 'discussion', reply);
    // Grow 500 × 64 other-author rows in the same route partition while keeping this author's page fixed.
    await seed(db, otherAuthorItems(reply, randomUUID().slice(0, 6)), { from: 0, to: 500 * 64 });
    const measured = await capture(db, () => get(path(author, kind, { limit: '1' })));
    expect(measured.value.status).toBe(200);
    captures.push({
      capture: measured.capture,
      index: reply ? 'author_item_post_page_idx' : 'author_item_page_idx',
    });
  }

  for (const measured of captures) {
    expect(
      measured.capture.statements.some((statement) => /\b(SET|set_config)\b[^;]*\benable_/is.test(statement)),
    ).toBe(false);
    expectAuthorPageIndex(measured.capture.plans, measured.index);
  }
});

for (const reply of [false, true])
  test(reply ? 'author post page' : 'author thread page', async () => {
    const author = newId(authorRoute);
    await ensureAuthor(author);
    for (let index = 0; index < 4; index++)
      await fixture(author, `2026-01-0${index + 1}T00:00:00Z`, 'discussion', reply);
    const population = otherAuthorItems(reply, randomUUID().slice(0, 6));
    // This check grows 500 × scale other-author content.author_item rows in this route partition.
    const report = await checkGrowth(db, {
      name: reply ? 'Author post page' : 'Author thread page',
      scales: [64, 512, 4096],
      warmups: 1,
      repetitions: 1,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: (database, scale, previous) => seed(database, population, { from: previous * 500, to: scale * 500 }),
      async operation() {
        const page = await get(path(author, reply ? 'posts' : 'threads', { limit: '2' }));
        expect(page.status).toBe(200);
        expect(page.body[reply ? 'posts' : 'threads']).toHaveLength(2);
        const next = await get(path(author, reply ? 'posts' : 'threads', { limit: '2', cursor: page.body.next }));
        expect(next.status).toBe(200);
        expect(next.body[reply ? 'posts' : 'threads']).toHaveLength(2);
      },
    });
    expect(report.samples.map((s) => s.scale)).toEqual([64, 512, 4096]);
  });
