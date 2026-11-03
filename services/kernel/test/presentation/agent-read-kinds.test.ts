import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import type { Pool } from 'pg';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { createKernel } from '../../src/http/kernel.ts';
import { readPartition } from '../../src/partition/partition.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { ensureAccountAgent, verifyAccountAgent } from '../../src/semantic/account-agents.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linksCaughtUp } from '../../src/semantic/link-freshness.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createRealAccess } from '../semantic/real-access.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

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
let activityBaselineAccount: Account;
let pageGrowthAccount: Account;
let verifiedAccount: Account;
let organizationAccount: Account;
let deletedAccount: Account;
let catalogueSubject: string;
let organizationAgent: string;
let profile: PresentationProfile;

const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const document = (...content: ReturnType<typeof node>[]) => ({ root: { props: {} }, content });

async function ensureAccount(
  handle: string,
  displayName = 'Public agent',
  { kind = 'actor', state = 'active' }: { kind?: 'actor' | 'organization'; state?: 'active' | 'deleted' } = {},
): Promise<Account> {
  const route = 0x5210;
  const id = newId(route);
  await admin.query(
    `INSERT INTO access.account
       (route,account_id,kind,state,handle,display_name,biography,links,transaction_id)
     VALUES ($1,$2,$4,$5,$3,$6,'A public agent biography','[{"label":"Site","url":"https://example.test"}]'::jsonb,$2)`,
    [route, id, handle, kind, state, displayName],
  );
  await admin.query(
    `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id)
     VALUES ($1,$2,$3,'active',$3)`,
    [handleRoute(handle), handle, id],
  );
  return { id, handle };
}

function accountNodes() {
  return [
    node('SubjectHeader', 'header'),
    node('AccountIdentity', 'identity'),
    node('AccountThreads', 'discussions', { threadKind: 'discussion', limit: 1 }),
    node('AccountThreads', 'reviews', { threadKind: 'review', limit: 1 }),
    node('AccountPosts', 'posts', { limit: 1 }),
    node('AccountCollections', 'collections', { limit: 1 }),
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

async function seedAgentCollections(accountId: string, count: number): Promise<void> {
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
}

async function seedUnrelatedAccounts(count: number): Promise<void> {
  for (let offset = 0; offset < count; offset += 1_000) {
    const amount = Math.min(1_000, count - offset);
    const ids = Array.from({ length: amount }, () => newId(0x5210));
    const handles = ids.map((id) => `unrelated_${id.replaceAll('-', '')}`);
    const routes = handles.map(handleRoute);
    await admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,handle,transaction_id)
       SELECT $1,id,'actor','active',handle,id FROM unnest($2::uuid[],$3::text[]) AS rows(id,handle)`,
      [0x5210, ids, handles],
    );
    await admin.query(
      `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id)
       SELECT route,handle,id,'active',id FROM unnest($1::integer[],$2::text[],$3::uuid[]) AS rows(route,handle,id)`,
      [routes, handles, ids],
    );
  }
}

async function call(method: string, path: string, body?: unknown, editor = false) {
  const headers: Record<string, string> = {};
  if (editor) {
    headers.authorization = `Bearer ${realAccess.bearer('editor')}`;
    headers['idempotency-key'] = `"${randomUUID()}"`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

async function readPage(target: Record<string, unknown>) {
  return call('POST', '/v1/pages:read', { target });
}

async function createCatalogueSubject(type: string, label: string): Promise<string> {
  const created = await call('POST', '/v1/subjects', { type, labels: { en: label } }, true);
  expect(created.response.status, JSON.stringify(created.body)).toBe(201);
  return trackSetupSubject(created.body.subject.id);
}

const setupSubjects = new Set<string>();
// Definition and profile bootstrap both commit in the Global Context's home.
const setupHomes = new Set([partitionOf(routeOf(GLOBAL_CONTEXT)!)]);

function trackSetupSubject(id: string): string {
  setupSubjects.add(id);
  setupHomes.add(partitionOf(routeOf(id)!));
  return id;
}

async function projectSetup(): Promise<void> {
  const projection = linkProjection(pool);
  for (let round = 0; round < 50; round++) {
    let progressed = false;
    for (const partition of setupHomes) {
      const result = await projection.run(partition);
      if (result.status !== 'read')
        throw new Error(
          `Semantic setup projection ${partition}: ${result.status}${result.status === 'stopped' ? ` (${result.reason}) at ${result.position}` : ''}`,
        );
      progressed ||= result.envelopes > 0;
    }
    // Applying a merge batch can emit events back into a home already visited.
    if (progressed) continue;
    const seen = [];
    for (const partition of setupHomes) {
      const head = await readPartition(pool, partition);
      if (!head) throw new Error(`Semantic setup home ${partition} is unavailable`);
      seen.push({ partition, epoch: head.epoch, position: head.position });
    }
    for (const subject of setupSubjects)
      expect(
        await linksCaughtUp(pool, seen, subject, undefined, [...setupSubjects]),
        `Semantic setup must cover ${subject} at ${seen.map((head) => `${head.partition}.${head.epoch}:${head.position}`).join(', ')}`,
      ).toBe(true);
    return;
  }
  throw new Error('Semantic setup projection did not reach quiescence in 50 bounded relay rounds');
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
    receiptKeys: testReceiptKeys(),
  });
  await bootstrapRelease(pool, bundledRelease);
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
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
  activityBaselineAccount = await ensureAccount(`baseline_${randomUUID().replaceAll('-', '')}`);
  pageGrowthAccount = await ensureAccount(`pagegrowth_${randomUUID().replaceAll('-', '')}`);
  verifiedAccount = await ensureAccount(`verified_${randomUUID().replaceAll('-', '')}`, 'Verified agent');
  organizationAccount = await ensureAccount(`organization_${randomUUID().replaceAll('-', '')}`, 'Agent organization', {
    kind: 'organization',
  });
  deletedAccount = await ensureAccount(`deleted_${randomUUID().replaceAll('-', '')}`, 'Deleted agent', {
    kind: 'actor',
    state: 'deleted',
  });
  await seedUnrelatedAccounts(4_096);
  await seedAgentItems(
    activityBaselineAccount.id,
    Array.from({ length: 256 }, () => ({ kind: 'discussion' as const })),
    'agent-activity-index-baseline',
  );

  await seedAgentItems(
    pageAccount.id,
    [{ kind: 'discussion' }, { kind: 'discussion' }, { kind: 'review' }, { kind: 'review' }],
    `agent-page-${randomUUID()}`,
  );
  await seedAgentCollections(pageAccount.id, 2);

  // The organization is unverified: its page is its own graph agent's page, resolved by the agent's type.
  const organization = await ensureAccountAgent(pool, {
    account: organizationAccount.id,
    kind: 'organization',
    name: 'Agent organization',
    language: 'en',
  });
  organizationAgent = trackSetupSubject(organization.subject.id);

  // The verified account's agent is merged into a catalogue subject; accounts stores the verification on the row.
  const verified = await ensureAccountAgent(pool, {
    account: verifiedAccount.id,
    kind: 'person',
    name: 'Verified agent',
    language: 'en',
  });
  trackSetupSubject(verified.subject.id);
  catalogueSubject = await createCatalogueSubject('schema:Person', 'Catalogue Person');
  const receipt = randomUUID();
  const verification = await verifyAccountAgent(pool, {
    account: verifiedAccount.id,
    catalogue: catalogueSubject,
    receipt,
  });
  setupHomes.add(verification.component.partition);
  trackSetupSubject(verification.subject.id);
  trackSetupSubject(verification.survivor);
  trackSetupSubject(verification.redirected);
  await admin.query(
    `UPDATE access.account
     SET agent_verified = true, agent_subject_id = $3, agent_verification_receipt_id = $4
     WHERE route = $1 AND account_id = $2`,
    [routeOf(verifiedAccount.id), verifiedAccount.id, catalogueSubject, receipt],
  );

  const accountDocument = document(...accountNodes());
  profile = {
    format: PROFILE_FORMAT,
    generic: document(node('Heading', 'generic', { text: 'Agent', level: 1 })),
    bases: [],
    types: [
      {
        type: 'schema:Organization',
        document: document(node('SubjectHeader', 'header'), node('AccountIdentity', 'identity')),
      },
      { type: 'schema:Person', document: accountDocument },
    ],
    routes: [],
  };
  await bootstrapProfile(pool, profile);
  // Real setup work is complete before any page/read or checkGrowth operation is measured.
  await projectSetup();
});

afterAll(async () => {
  await growth?.close();
});

test.serial('an account page read resolves the account by handle and plans its lists in one pass', async () => {
  // This account has no graph agent, so the page resolves by the account's kind.
  const answer = await readPage({ account: pageAccount.handle });
  expect(answer.response.status).toBe(200);
  expect(answer.body.profile).toBe(profileDigest(profile));
  expect(answer.body.account).toBe(pageAccount.id);
  expect(answer.body).not.toHaveProperty('subject');
  expect(answer.body.template).toEqual({ scope: 'type', key: 'schema:Person' });
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

  // Each list is the standalone read with a continuation for the reader to follow.
  const discussions = await getJson(`/v1/accounts/${pageAccount.id}/threads?kind=discussion&limit=1`);
  const reviews = await getJson(`/v1/accounts/${pageAccount.id}/threads?kind=review&limit=1`);
  const posts = await getJson(`/v1/accounts/${pageAccount.id}/posts?limit=1`);
  const collections = await getJson(`/v1/accounts/${pageAccount.id}/collections?view=BASIC&limit=1`);
  // The continuations are sealed per request, so compare the entries and require a continuation.
  const sameEntries = ({ next: _next, ...entries }: Record<string, any>) => entries;
  expect(sameEntries(answer.body.reads.r1.body)).toEqual(sameEntries(discussions));
  expect(sameEntries(answer.body.reads.r2.body)).toEqual(sameEntries(reviews));
  expect(sameEntries(answer.body.reads.r3.body)).toEqual(sameEntries(posts));
  expect(sameEntries(answer.body.reads.r4.body)).toEqual(sameEntries(collections));
  for (const key of ['r1', 'r2', 'r3', 'r4']) expect(answer.body.reads[key].body.next).toBeString();
  for (const list of [discussions, reviews, posts, collections]) expect(list.next).toBeString();
  expect(discussions.threads).toHaveLength(1);
  expect(reviews.threads).toHaveLength(1);
  expect(posts.posts).toHaveLength(1);
  expect(posts.posts[0].thread).toHaveProperty('id');
  expect(posts.posts[0].thread).toHaveProperty('title');
  expect(collections.collections).toHaveLength(1);
});

test.serial('an unknown or deleted handle answers the same 404 as an unknown subject', async () => {
  const unknownSubject = await readPage({ subject: newId(contentRoute) });
  expect(unknownSubject.response.status).toBe(404);
  const unknown = await readPage({ account: `missing_${randomUUID().replaceAll('-', '')}` });
  const deleted = await readPage({ account: deletedAccount.handle });
  for (const answer of [unknown, deleted]) {
    expect(answer.response.status).toBe(404);
    expect(answer.response.headers.get('content-type')).toBe(unknownSubject.response.headers.get('content-type'));
    expect(answer.body.type).toBe(unknownSubject.body.type);
    expect(answer.body.title).toBe(unknownSubject.body.title);
    expect(answer.body.status).toBe(404);
    expect(answer.body).not.toHaveProperty('reads');
  }
});

test.serial(
  "an account verified as a catalogue subject answers that subject's page with the account's reads",
  async () => {
    const answer = await readPage({ account: verifiedAccount.handle });
    expect(answer.response.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.account).toBe(verifiedAccount.id);
    expect(answer.body.subject).toBe(catalogueSubject);
    expect(answer.body.template).toEqual({ scope: 'type', key: 'schema:Person' });
    expect(Object.keys(answer.body.reads)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
    const subject = await getJson(`/v1/subjects/${catalogueSubject}`);
    expect(answer.body.reads.r0).toEqual({ status: 200, body: subject });
    expect(answer.body.reads.r0.body.subject.type).toBe('schema:Person');
    expect(answer.body.reads.r1.body.accounts[0]).toMatchObject({
      id: verifiedAccount.id,
      verified: true,
      subject: { id: catalogueSubject, type: 'schema:Person' },
    });
    expect(answer.body.reads.r2.body).toHaveProperty('threads');
    expect(answer.body.reads.r3.body).toHaveProperty('threads');
    expect(answer.body.reads.r4.body).toHaveProperty('posts');
    expect(answer.body.reads.r5.body).toHaveProperty('collections');
  },
);

test.serial(
  "an unverified organization account answers its agent subject's page with the organization template",
  async () => {
    const answer = await readPage({ account: organizationAccount.handle });
    expect(answer.response.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.account).toBe(organizationAccount.id);
    expect(answer.body.subject).toBe(organizationAgent);
    expect(answer.body.template).toEqual({ scope: 'type', key: 'schema:Organization' });
    expect(Object.keys(answer.body.reads)).toEqual(['r0', 'r1']);
    expect(answer.body.reads.r0.body.subject).toMatchObject({ id: organizationAgent, type: 'schema:Organization' });
    expect(answer.body.reads.r1.body.accounts[0]).toMatchObject({
      id: organizationAccount.id,
      kind: 'organization',
      verified: false,
      subject: { id: organizationAgent, type: 'schema:Organization' },
    });
  },
);

test.serial('a malformed account target answers 400 at /target/account', async () => {
  for (const [account, code] of [
    ['', 'invalid_format'],
    ['-leading', 'invalid_format'],
    ['has space', 'invalid_format'],
    ['x'.repeat(65), 'invalid_format'],
    [7, 'invalid_type'],
    [null, 'invalid_type'],
  ] as const) {
    const answer = await readPage({ account });
    expect(answer.response.status).toBe(400);
    expect(answer.body.errors).toEqual([{ pointer: '/target/account', code }]);
  }
  const both = await readPage({ account: pageAccount.handle, route: '/agent' });
  expect(both.response.status).toBe(400);
  expect(both.body.errors).toEqual([{ pointer: '/target', code: 'invalid_type' }]);
});

test.serial('account page read stays within its bound at 1, 10 and 100 threads', async () => {
  const report = await checkGrowth(growth, {
    name: 'Account page read',
    scales: [1, 10, 100],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(_database, scale, previous) {
      await seedAgentItems(
        pageGrowthAccount.id,
        Array.from({ length: scale - previous }, () => ({ kind: 'discussion' as const })),
        'account-page-growth',
      );
    },
    async operation(_database, scale) {
      const answer = await readPage({ account: pageGrowthAccount.handle });
      expect(answer.response.status).toBe(200);
      expect(answer.body.account).toBe(pageGrowthAccount.id);
      expect(answer.body.reads.r1.body.threads).toHaveLength(1);
      if (scale > 1) expect(answer.body.reads.r1.body.next).toBeString();
      return answer.body;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 10, 100]);
  assertConstantStatements(report.samples);
  const within = (relation: string, limit: number) =>
    report.samples.every(({ cost }) => (cost.relations[relation]?.rows ?? 0) <= limit);
  expect(within('access.handle_claim', 1)).toBe(true);
  // The account probe plus one visibility check for each of the four lists.
  expect(within('access.account', 5)).toBe(true);
  expect(within('content.author_item', 16)).toBe(true);
  expect(within('content.thread', 24)).toBe(true);
  expect(within('content.post', 12)).toBe(true);
  expect(within('content.board', 20)).toBe(true);
  expect(within('content.revision', 24)).toBe(true);
  expect(within('library.collection', 4)).toBe(true);
});

test.serial('account identity read stays within its bound at 1, 10 and 100 unrelated accounts', async () => {
  const report = await checkGrowth(growth, {
    name: 'Account identity page read',
    scales: [1, 10, 100],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(database, scale, previous) {
      const values = Array.from({ length: (scale - previous) * 16 }, () => {
        const id = newId(0x6041);
        const handle = `unrelated_${randomUUID().replaceAll('-', '')}`;
        return { id, handle, handleRoute: handleRoute(handle) };
      });
      const ids = values.map(({ id }) => id);
      const handles = values.map(({ handle }) => handle);
      const routes = values.map(({ handleRoute }) => handleRoute);
      await database.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,handle,transaction_id)
         SELECT route,id,'actor','active',handle,id FROM unnest($1::integer[],$2::uuid[],$3::text[]) AS rows(route,id,handle)`,
        [ids.map((id) => routeOf(id)!), ids, handles],
      );
      await database.admin.query(
        `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id)
         SELECT route,handle,id,'active',id FROM unnest($1::integer[],$2::text[],$3::uuid[]) AS rows(route,handle,id)`,
        [routes, handles, ids],
      );
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
    slack: { rows: { absolute: 3, relative: 0 } },
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
  expect(report.samples.every(({ cost }) => (cost.relations['content.thread']?.rows ?? 0) <= 6)).toBe(true);
  expect(report.samples.every(({ cost }) => (cost.relations['content.board']?.rows ?? 0) <= 5)).toBe(true);
  expect(report.samples.every(({ cost }) => (cost.relations['content.revision']?.rows ?? 0) <= 6)).toBe(true);
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
  expect(report.samples.every(({ cost }) => (cost.relations['content.thread']?.rows ?? 0) <= 11)).toBe(true);
  expect(report.samples.every(({ cost }) => (cost.relations['content.post']?.rows ?? 0) <= 6)).toBe(true);
  expect(report.samples.every(({ cost }) => (cost.relations['content.board']?.rows ?? 0) <= 10)).toBe(true);
  expect(report.samples.every(({ cost }) => (cost.relations['content.revision']?.rows ?? 0) <= 12)).toBe(true);
});

test.serial('account collections read stays within its bound at 1, 10 and 100 collections', async () => {
  const report = await checkGrowth(growth, {
    name: 'Account public collections page read',
    scales: [1, 10, 100],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(_database, scale, previous) {
      await seedAgentCollections(collectionGrowthAccount.id, scale - previous);
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
  expect(report.samples.every(({ cost }) => (cost.relations['library.collection']?.rows ?? 0) <= 4)).toBe(true);
});
