import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { capture, costOf, openGrowthDatabase, seed } from '../support/growth.ts';

const authorRoute = 0x9abc;
const contentRoute = 0x1234;
const boardRoute = 0x4321;
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const issuer = 'https://author-views.test';
const audience = 'https://kernel.test';
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let app: ReturnType<typeof createKernel>;
let signingKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKey: Record<string, unknown>;
let viewer: string;

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  signingKeys = await generateKeyPair('ES256');
  publicKey = { ...(await exportJWK(signingKeys.publicKey)), kid: 'author-views', alg: 'ES256' };
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
  const fetchGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(app), 'fetch')?.get;
  if (!fetchGetter) throw new Error('Elysia fetch getter is unavailable');
  fetchGetter.call(app);
  viewer = newId(authorRoute);
  await account(viewer);
});

afterAll(async () => {
  await db?.close();
});

const body = Buffer.from(JSON.stringify(fromPlainText('Profile reply')));
const viewOff = { posts: false, reviews: false, collections: false, realms: false };

async function account(
  id: string,
  options: { kind?: 'actor' | 'organization'; state?: string; fenced?: boolean; inverseComplete?: boolean } = {},
) {
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,authn_fenced,membership_inverse_complete,transaction_id)
     VALUES ($1,$2,$3,$4,$5,$6,$2)`,
    [
      routeOf(id),
      id,
      options.kind ?? 'actor',
      options.state ?? 'active',
      options.fenced ?? false,
      options.inverseComplete ?? false,
    ],
  );
}

async function setViews(
  id: string,
  value: { posts: boolean; reviews: boolean; collections: boolean; realms: boolean },
) {
  await db.admin.query('UPDATE access.account SET public_views=$3::jsonb WHERE route=$1 AND account_id=$2', [
    routeOf(id),
    id,
    JSON.stringify(value),
  ]);
}

async function actingOwner(actorId: string, organizationId: string) {
  await account(actorId, { inverseComplete: true });
  await account(organizationId, { kind: 'organization' });
  const reservationId = newId(routeOf(actorId)!);
  await db.admin.query(
    `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
     VALUES ($1,$2,'organization',$3,$4,$5)`,
    [routeOf(actorId), actorId, organizationId, reservationId, reservationId],
  );
  await db.admin.query(
    `INSERT INTO access.organization_member(route,organization_id,member_account_id,role,valid,transaction_id)
     VALUES ($1,$2,$3,'owner','(,)',$4)`,
    [routeOf(organizationId), organizationId, actorId, reservationId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,subject_role,action,valid,transaction_id)
     VALUES ($1,$2,$2,'owner','account:update','(,)',$3)`,
    [routeOf(organizationId), organizationId, reservationId],
  );
}

function records(author: string, kind: 'discussion' | 'review', at: string, reply = false) {
  const home = kind === 'review' ? routeOf(author)! : contentRoute;
  const target = newId(home);
  const thread = newId(home);
  const opening = newId(home);
  const post = reply ? newId(home) : opening;
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
    thread,
    post,
    rows: {
      'content.board':
        kind === 'review'
          ? []
          : [
              {
                ...common,
                route: boardRoute,
                board_id: board,
                subject_id: newId(boardRoute),
                realm_id: null,
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
      'content.revision': posts.map((item) => ({
        route: home,
        thread_id: thread,
        post_id: item.post_id,
        revision_id: item.head_revision_id,
        body,
        body_sha256: new Uint8Array(new Bun.CryptoHasher('sha256').update(body).digest()),
        search_text: 'Profile reply',
        licence: 'MIT',
        subject_ids: kind === 'review' && item.post_id === opening ? [target] : [],
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

async function item(author: string, kind: 'discussion' | 'review', index: number, reply = false) {
  const value = records(author, kind, new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(), reply);
  await seed(
    db,
    {
      name: crypto.randomUUID(),
      hotPartition: (kind === 'review' ? routeOf(author)! : contentRoute) >>> 4,
      rows: () => value.rows,
    },
    { from: 0, to: 1 },
  );
  return value;
}

async function token(accountId: string, scopes = 'thread:read post:read board:read realm:read account:update') {
  return new SignJWT({
    client_id: 'web',
    scope: scopes,
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'author-views', typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('3m')
    .sign(signingKeys.privateKey);
}

function path(author: string, list: 'threads' | 'posts', kind?: 'discussion' | 'review') {
  const query = kind ? `?kind=${kind}` : '';
  return `/v1/accounts/${author}/${list}${query}`;
}

async function get(url: string, bearer?: string) {
  const response = await app.handle(
    new Request(`http://kernel.test${url}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

test('private author lists are empty to other viewers but remain visible to the account and its acting organization owner', async () => {
  const author = newId(authorRoute);
  await account(author);
  const discussion = await item(author, 'discussion', 1);
  const reply = await item(author, 'discussion', 2, true);
  const review = await item(author, 'review', 3);
  await setViews(author, { posts: false, reviews: true, collections: true, realms: false });

  const outsider = await token(viewer);
  for (const [url, key] of [
    [path(author, 'threads'), 'threads'],
    [path(author, 'posts'), 'posts'],
  ] as const) {
    for (const bearer of [undefined, outsider]) {
      const page = await get(url, bearer);
      expect(page.status).toBe(200);
      expect(page.body[key]).toEqual([]);
      expect(page.body.next).toBeNull();
    }
  }
  expect(
    (await get(path(author, 'threads', 'review'), outsider)).body.threads.map((value: { id: string }) => value.id),
  ).toContain(review.thread);
  await setViews(author, { posts: false, reviews: false, collections: true, realms: false });
  expect((await get(path(author, 'threads', 'review'), outsider)).body).toEqual({ threads: [], next: null });

  const self = await token(author);
  expect((await get(path(author, 'threads'), self)).body.threads.map((value: { id: string }) => value.id)).toContain(
    discussion.thread,
  );
  expect((await get(path(author, 'posts'), self)).body.posts.map((value: { id: string }) => value.id)).toContain(
    reply.post,
  );
  expect(
    (await get(path(author, 'threads', 'review'), self)).body.threads.map((value: { id: string }) => value.id),
  ).toContain(review.thread);

  const organization = newId(authorRoute);
  const owner = newId(authorRoute);
  await actingOwner(owner, organization);
  const orgDiscussion = await item(organization, 'discussion', 4);
  const orgReply = await item(organization, 'discussion', 5, true);
  const orgReview = await item(organization, 'review', 6);
  await setViews(organization, viewOff);

  for (const [url, key] of [
    [path(organization, 'threads'), 'threads'],
    [path(organization, 'posts'), 'posts'],
    [path(organization, 'threads', 'review'), 'threads'],
  ] as const) {
    for (const bearer of [undefined, outsider]) {
      const page = await get(url, bearer);
      expect(page.body[key]).toEqual([]);
      expect(page.body.next).toBeNull();
    }
  }
  const ownerBearer = await token(owner);
  expect(
    (await get(path(organization, 'threads'), ownerBearer)).body.threads.map((value: { id: string }) => value.id),
  ).toContain(orgDiscussion.thread);
  expect(
    (await get(path(organization, 'posts'), ownerBearer)).body.posts.map((value: { id: string }) => value.id),
  ).toContain(orgReply.post);
  expect(
    (await get(path(organization, 'threads', 'review'), ownerBearer)).body.threads.map(
      (value: { id: string }) => value.id,
    ),
  ).toContain(orgReview.thread);
});

test('deleted, fenced and unknown accounts return empty author pages', async () => {
  const deleted = newId(authorRoute);
  await account(deleted, { state: 'deleted' });
  await item(deleted, 'discussion', 10);
  await item(deleted, 'discussion', 13, true);
  await item(deleted, 'review', 14);
  const fenced = newId(authorRoute);
  await account(fenced, { fenced: true });
  await item(fenced, 'discussion', 11);
  await item(fenced, 'discussion', 15, true);
  await item(fenced, 'review', 16);
  const unknown = newId(authorRoute);
  await item(unknown, 'discussion', 12);
  await item(unknown, 'discussion', 17, true);
  await item(unknown, 'review', 18);

  for (const id of [deleted, fenced, unknown]) {
    for (const url of [path(id, 'threads'), path(id, 'posts'), path(id, 'threads', 'review')]) {
      const page = await get(url);
      expect(page.status).toBe(200);
      expect(page.body).toMatchObject({ next: null });
      expect(page.body.threads ?? page.body.posts).toEqual([]);
    }
  }
});

// access.account grows in production; the bounded neighbourhood is one author's page and one public view read
// of that author. Seed unrelated accounts in the same route with production row shapes to observe the unforced plan.
test('one public view read is added to each author page at any item count', async () => {
  const author = newId(authorRoute);
  await account(author);
  await item(author, 'discussion', 20);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,authn_fenced,membership_inverse_complete,transaction_id)
     SELECT $1,id,'actor','active',false,false,id FROM unnest($2::uuid[]) AS ids(id)`,
    [authorRoute, Array.from({ length: 500 }, () => newId(authorRoute))],
  );

  function accountScans(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) return value.flatMap(accountScans);
    if (value === null || typeof value !== 'object') return [];
    const node = value as Record<string, unknown>;
    return [
      ...(node.Schema === 'access' && node['Relation Name'] === 'account' ? [node] : []),
      ...Object.values(node).flatMap(accountScans),
    ];
  }

  async function reads() {
    const result = await capture(db, () => get(path(author, 'threads')));
    expect(result.value.status).toBe(200);
    expect(result.capture.statements.filter((statement) => statement.includes('public_views'))).toHaveLength(1);
    const statement = result.capture.statements.find((statement) => statement.includes('public_views'));
    const plans = result.capture.plans
      .flatMap((plan): unknown[] => (Array.isArray(plan) ? plan : [plan]))
      .filter(
        (plan) => plan !== null && typeof plan === 'object' && 'Query Text' in plan && plan['Query Text'] === statement,
      );
    expect(plans).toHaveLength(1);
    expect(accountScans(plans)).toEqual([
      expect.objectContaining({
        'Node Type': expect.stringMatching(/^Index (?:Only )?Scan$/),
        'Index Name': 'account_pkey',
      }),
    ]);
    expect(costOf(result.capture).relations['access.account']?.rows).toBe(1);
  }

  await reads();
  for (let index = 21; index < 29; index++) await item(author, 'discussion', index);
  await reads();
});
