import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { fromPlainText } from '@rezics/document';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createAccess } from '../../src/access/index.ts';
import { createRegistrationPorts } from '../support/registration-ports.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import installedRoles from '../../src/access/resource-roles.json';
import { resolveResourceRoles } from '../../src/access/resource-roles.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import type { ActionCatalogue } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const issuer = 'https://reactions-http.auth.test';
const audience = 'https://reactions-http.api.test';
const password = 'reactions http registration password with enough entropy';
const routeKey = new Uint8Array(32).fill(91);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(92)]]) };
const contentRoute = 0x4231;
const boardRoute = 0x5231;
const reactionPaths = ['/v1/threads/{id}/reaction', '/v1/posts/{id}/reaction'] as const;

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let authPool: Pool;
let authDatabaseName = '';
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let author: { accountId: string; bearer: string };
let member: { accountId: string; bearer: string; narrow: string };
let published: { thread: string; posts: string[] };
let hidden: { thread: string; post: string };

type Call = { bearer?: string; body?: unknown; key?: string };

async function issue(email: string, scope: string[]) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'reactions-http-client', scope }),
    }),
  );
  expect(signed.status).toBe(200);
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const response = await service.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: '{}',
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function person(name: string, scope: string[]) {
  const result = await host.workflows.register({
    key: name,
    handle: name,
    email: `${name}@reactions-http.test`,
    password,
  });
  return { accountId: result.accountId, bearer: await issue(`${name}@reactions-http.test`, scope) };
}

async function call(method: string, path: string, options: Call = {}) {
  const headers = new Headers();
  if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.key !== undefined) headers.set(IDEMPOTENCY_HEADER, JSON.stringify(options.key));
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  const text = await response.text();
  return { response, text, value: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

async function effects(targetId: string) {
  const result = await db.admin.query<{ slots: number; events: number; receipts: number }>(
    `SELECT
       (SELECT count(*)::int FROM content.reaction WHERE target_id = $1::uuid) AS slots,
       (SELECT count(*)::int FROM core.outbox WHERE subject = $2) AS events,
       (SELECT count(*)::int FROM core.receipt) AS receipts`,
    [targetId, targetId],
  );
  return result.rows[0]!;
}

function standingCatalogue(actions: ActionCatalogue): ActionCatalogue {
  const copy = new Map(actions);
  // Production leaves these unmounted, which drops the standing roles. The role
  // text still has to name reaction:set beside them for when they mount.
  for (const action of ['report:create', 'post:erase', 'media:erase']) {
    if (!copy.has(action)) copy.set(action, { anonymous: false });
  }
  return copy;
}

async function insertThread(visibility: 'published' | 'taken_down', count: number, title: string) {
  const board = newId(boardRoute);
  const thread = newId(contentRoute);
  const posts: string[] = [];
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,'published',1,$2)`,
      [boardRoute, board, author.accountId, title],
    );
    const first = newId(contentRoute);
    await client.query(
      `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id)
       VALUES ($1,$2,$3,$4,$5,$6,1,$2,$7)`,
      [contentRoute, thread, author.accountId, board, title, visibility, first],
    );
    for (let index = 0; index < count; index++) {
      const post = index === 0 ? first : newId(contentRoute);
      const revision = newId(contentRoute);
      const text = `${title} ${index}`;
      const body = Buffer.from(JSON.stringify(fromPlainText(text)));
      const at = new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString();
      await client.query(
        `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id,created_at)
         VALUES ($1,$2,$3,$4,$5,'published',1,$3,$6)`,
        [contentRoute, thread, post, author.accountId, revision, at],
      );
      await client.query(
        `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
         VALUES ($1,$2,$3,$4,$5,sha256($5),$6,'MIT','{}',$7,'available',$4)`,
        [contentRoute, thread, post, revision, body, text, board],
      );
      posts.push(post);
    }
    for (const subjectId of [author.accountId, member.accountId]) {
      for (const resourceId of [thread, ...posts]) {
        await client.query(
          `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
           VALUES ($1,$2,$3,'reaction:set','(,)',$4)`,
          [routeOf(resourceId), resourceId, subjectId, newId(routeOf(resourceId)!)],
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { thread, posts };
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 4;
  const url = db.url;
  authDatabaseName = `reactions_http_auth_${process.pid}`;
  await db.admin.query(`CREATE DATABASE ${authDatabaseName}`);
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabaseName}`;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'reactions-http',
  };
  const limiter = createWriteRateLimiter({
    secret: 'reactions-http-private-write-rate-secret-32b',
    overrides: JSON.stringify({
      anonymous: { write: { maximum: 100000, seconds: 86400 } },
      'new-account': { write: { maximum: 100000, seconds: 86400 } },
    }),
  });
  kernel = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
        },
      }),
    writeRate: limiter,
  });
  const scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
  const registration = createRegistrationProofBindings({ pool: db.pool, referenceKeys: tokens });
  const { ports: registrationPorts } = createRegistrationPorts({
    pool: db.pool,
    authPool,
    routeKey,
    referenceKeys: tokens,
  });
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: 'reactions-http-auth-persistent-secret-32b',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool: db.pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(93),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'reactions-http-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'reactions-http-client', firstParty: true, scopes });
  await host.start();
  author = await person('reactions_author', scopes);
  const registered = await person('reactions_member', scopes);
  member = {
    ...registered,
    narrow: await issue(
      'reactions_member@reactions-http.test',
      scopes.filter((scope) => scope !== 'reaction:set'),
    ),
  };
  published = await insertThread('published', 4, 'Visible thread');
  const concealed = await insertThread('taken_down', 1, 'Concealed thread');
  hidden = { thread: concealed.thread, post: concealed.posts[0]! };
}, 60_000);

afterAll(async () => {
  await host?.stop();
  if (authPool && !authPool.ending) await authPool.end();
  if (authDatabaseName) await dropTestDatabase(db!.admin, authDatabaseName);
  await db?.close();
});

test.serial(
  'an active account sets, changes and clears its reaction on a thread and a post, and the thread view and post page show its own kind',
  async () => {
    const actions = actionCatalogue(kernel);
    expect(actions.has('reaction:set')).toBe(true);
    expect(actions.get('reaction:set')?.anonymous).toBe(false);
    expect(installedRoles.roles['content.thread.standing']).toContain('reaction:set');
    expect(installedRoles.roles['content.post.standing']).toContain('reaction:set');
    expect(installedRoles.roles['content.thread.standing']).toContain('report:create');
    expect(installedRoles.roles['content.post.standing']).toContain('report:create');
    expect(installedRoles.roles['content.post.owner']).toContain('post:erase');
    const resolved = resolveResourceRoles(standingCatalogue(actions));
    expect(resolved.roles.get('content.thread.standing')).toContain('reaction:set');
    expect(resolved.roles.get('content.post.standing')).toContain('reaction:set');
    const document = openApiDocument(kernel);
    expect(document.paths['/v1/threads/{id}/reaction']?.put?.operationId).toBe('thread.set_reaction');
    expect(document.paths['/v1/threads/{id}/reaction']?.delete?.operationId).toBe('thread.clear_reaction');
    expect(document.paths['/v1/posts/{id}/reaction']?.put?.operationId).toBe('post.set_reaction');
    expect(document.paths['/v1/posts/{id}/reaction']?.delete?.operationId).toBe('post.clear_reaction');
    for (const path of reactionPaths) {
      expect(document.paths[path]?.put?.['x-action']).toBe('reaction:set');
      expect(document.paths[path]?.delete?.['x-action']).toBe('reaction:set');
      expect(document.paths[path]?.put?.security).toEqual([{ bearerAuth: [] }]);
      expect(document.paths[path]?.delete?.security).toEqual([{ bearerAuth: [] }]);
      expect(document.paths[path]?.put?.responses?.['200']).toBeDefined();
      expect(document.paths[path]?.delete?.responses?.['204']).toBeDefined();
    }
    expect(JSON.stringify(document.paths['/v1/threads/{id}']?.get?.responses?.['200'])).toContain('viewerReaction');
    expect(JSON.stringify(document.paths['/v1/threads/{id}/posts']?.get?.responses?.['200'])).toContain(
      'viewerReaction',
    );

    const threadPath = `/v1/threads/${published.thread}/reaction`;
    const postPath = `/v1/posts/${published.posts[0]}/reaction`;
    const before = await effects(published.thread);
    const liked = await call('PUT', threadPath, {
      bearer: member.bearer,
      key: crypto.randomUUID(),
      body: { kind: 'like' },
    });
    expect(liked.response.status).toBe(200);
    expect(liked.value).toEqual({ kind: 'like' });
    expect((await effects(published.thread)).events).toBe(before.events + 1);
    const loveKey = crypto.randomUUID();
    const loved = await call('PUT', threadPath, { bearer: member.bearer, key: loveKey, body: { kind: 'love' } });
    expect(loved.response.status).toBe(200);
    expect(loved.value).toEqual({ kind: 'love' });
    const changed = await effects(published.thread);
    expect(changed.slots).toBe(1);
    expect(changed.events).toBe(before.events + 2);
    const replay = await call('PUT', threadPath, { bearer: member.bearer, key: loveKey, body: { kind: 'love' } });
    expect(replay.response.status).toBe(200);
    expect(replay.value).toEqual({ kind: 'love' });
    const repeat = await call('PUT', threadPath, {
      bearer: member.bearer,
      key: crypto.randomUUID(),
      body: { kind: 'love' },
    });
    expect(repeat.response.status).toBe(200);
    expect(repeat.value).toEqual({ kind: 'love' });
    expect(await effects(published.thread)).toEqual({ ...changed, receipts: changed.receipts + 1 });

    const postBefore = await effects(published.posts[0]!);
    const postLiked = await call('PUT', postPath, {
      bearer: member.bearer,
      key: crypto.randomUUID(),
      body: { kind: 'like' },
    });
    expect(postLiked.response.status).toBe(200);
    expect(postLiked.value).toEqual({ kind: 'like' });
    const postLoved = await call('PUT', postPath, {
      bearer: member.bearer,
      key: crypto.randomUUID(),
      body: { kind: 'love' },
    });
    expect(postLoved.response.status).toBe(200);
    expect(postLoved.value).toEqual({ kind: 'love' });
    expect((await effects(published.posts[0]!)).slots).toBe(1);
    expect((await effects(published.posts[0]!)).events).toBe(postBefore.events + 2);

    const authorKey = crypto.randomUUID();
    const authorThread = await call('PUT', threadPath, {
      bearer: author.bearer,
      key: authorKey,
      body: { kind: 'upvote' },
    });
    expect(authorThread.response.status).toBe(200);
    expect(authorThread.value).toEqual({ kind: 'upvote' });
    const authorPost = await call('PUT', `/v1/posts/${published.posts[1]}/reaction`, {
      bearer: author.bearer,
      key: crypto.randomUUID(),
      body: { kind: 'insightful' },
    });
    expect(authorPost.response.status).toBe(200);
    expect(authorPost.value).toEqual({ kind: 'insightful' });

    const trace = observeSql(db.pool);
    try {
      const memberThread = await call('GET', `/v1/threads/${published.thread}`, { bearer: member.bearer });
      expect(memberThread.response.status).toBe(200);
      expect((memberThread.value?.thread as { viewerReaction: string }).viewerReaction).toBe('love');
      const memberPage = await call('GET', `/v1/threads/${published.thread}/posts?limit=100`, {
        bearer: member.bearer,
      });
      expect(memberPage.response.status).toBe(200);
      const memberPosts = memberPage.value?.posts as { id: string; viewerReaction: string | null }[];
      expect(memberPosts.map((post) => [post.id, post.viewerReaction])).toEqual([
        [published.posts[0]!, 'love'],
        [published.posts[1]!, null],
        [published.posts[2]!, null],
        [published.posts[3]!, null],
      ]);
      const authorView = await call('GET', `/v1/threads/${published.thread}`, { bearer: author.bearer });
      expect((authorView.value?.thread as { viewerReaction: string }).viewerReaction).toBe('upvote');
      const authorPage = await call('GET', `/v1/threads/${published.thread}/posts?limit=100`, {
        bearer: author.bearer,
      });
      const authorPosts = authorPage.value?.posts as { id: string; viewerReaction: string | null }[];
      expect(authorPosts.map((post) => post.viewerReaction)).toEqual([null, 'insightful', null, null]);
      expect(trace.records.filter((record) => /\bcontent\.reaction\b/.test(record.statement))).toHaveLength(4);
    } finally {
      await trace.close();
    }

    const clearKey = crypto.randomUUID();
    const cleared = await call('DELETE', threadPath, { bearer: member.bearer, key: clearKey });
    expect(cleared.response.status).toBe(204);
    expect(cleared.text).toBe('');
    const clearAgain = await call('DELETE', threadPath, { bearer: member.bearer, key: crypto.randomUUID() });
    expect(clearAgain.response.status).toBe(204);
    expect(clearAgain.text).toBe('');
    const clearReplay = await call('DELETE', threadPath, { bearer: member.bearer, key: clearKey });
    expect(clearReplay.response.status).toBe(204);
    expect((await effects(published.thread)).slots).toBe(1);
    const clearedPost = await call('DELETE', postPath, { bearer: member.bearer, key: crypto.randomUUID() });
    expect(clearedPost.response.status).toBe(204);
    expect(clearedPost.text).toBe('');
    expect((await effects(published.posts[0]!)).slots).toBe(0);
    const afterClear = await call('GET', `/v1/threads/${published.thread}`, { bearer: member.bearer });
    expect((afterClear.value?.thread as { viewerReaction: null }).viewerReaction).toBeNull();
    const afterPage = await call('GET', `/v1/threads/${published.thread}/posts?limit=100`, { bearer: member.bearer });
    const afterPosts = afterPage.value?.posts as { viewerReaction: string | null }[];
    expect(afterPosts.map((post) => post.viewerReaction)).toEqual([null, null, null, null]);
    const authorStill = await call('GET', `/v1/threads/${published.thread}`, { bearer: author.bearer });
    expect((authorStill.value?.thread as { viewerReaction: string }).viewerReaction).toBe('upvote');
  },
);

test.serial(
  'post reaction retries retain already-satisfied set and clear acknowledgements after a later choice',
  async () => {
    const path = `/v1/posts/${published.posts[2]}/reaction`;
    for (const method of ['PUT', 'DELETE']) {
      const command = {
        bearer: member.bearer,
        key: crypto.randomUUID(),
        ...(method === 'PUT' ? { body: { kind: 'like' } } : {}),
      };
      expect((await call(method, path, { ...command, key: crypto.randomUUID() })).response.status).toBe(
        method === 'PUT' ? 200 : 204,
      );
      const before = await effects(published.posts[2]!);
      expect((await call(method, path, command)).response.status).toBe(method === 'PUT' ? 200 : 204);
      expect(await effects(published.posts[2]!)).toEqual({ ...before, receipts: before.receipts + 1 });
      expect(
        (await call('PUT', path, { bearer: member.bearer, key: crypto.randomUUID(), body: { kind: 'love' } })).response
          .status,
      ).toBe(200);
      const later = await effects(published.posts[2]!);
      expect((await call(method, path, command)).response.status).toBe(method === 'PUT' ? 200 : 204);
      expect(await effects(published.posts[2]!)).toEqual(later);
      const read = await call('GET', `/v1/posts/${published.posts[2]}`, { bearer: member.bearer });
      expect(read.response.status).toBe(200);
      expect(read.value?.post).toHaveProperty('viewerReaction', 'love');
      if (method === 'PUT')
        expect((await call(method, path, { ...command, body: { kind: 'sad' } })).response.status).toBe(409);
    }
    expect((await call('DELETE', path, { bearer: member.bearer, key: crypto.randomUUID() })).response.status).toBe(204);
  },
);

test.serial(
  'anonymous sees no viewer reaction and cannot react, and a suspended account or an unreadable target is denied with no effect',
  async () => {
    // account:suspend is not mounted on this kernel, so this file does not suspend an account.
    const trace = observeSql(db.pool);
    try {
      const thread = await call('GET', `/v1/threads/${published.thread}`);
      expect(thread.response.status).toBe(200);
      expect(thread.value?.thread).not.toHaveProperty('viewerReaction');
      const page = await call('GET', `/v1/threads/${published.thread}/posts?limit=100`);
      expect(page.response.status).toBe(200);
      const posts = page.value?.posts as Record<string, unknown>[];
      expect(posts).toHaveLength(4);
      for (const post of posts) expect(post).not.toHaveProperty('viewerReaction');
      expect(trace.records.filter((record) => /\bcontent\.reaction\b/.test(record.statement))).toHaveLength(0);
    } finally {
      await trace.close();
    }

    const threadPath = `/v1/threads/${published.thread}/reaction`;
    const before = await effects(published.thread);
    const anonymousPut = await call('PUT', threadPath, { key: crypto.randomUUID(), body: { kind: 'like' } });
    expect(anonymousPut.response.status).toBe(401);
    expect(anonymousPut.value).toMatchObject({ code: 'authentication_required', effect_status: 'not_applied' });
    const anonymousDelete = await call('DELETE', threadPath, { key: crypto.randomUUID() });
    expect(anonymousDelete.response.status).toBe(401);
    expect(anonymousDelete.value).toMatchObject({ code: 'authentication_required', effect_status: 'not_applied' });
    expect(await effects(published.thread)).toEqual(before);

    const missingKey = await call('PUT', threadPath, { bearer: member.bearer, body: { kind: 'like' } });
    expect(missingKey.response.status).toBe(400);
    expect(missingKey.value).toMatchObject({ code: 'invalid_request', effect_status: 'not_applied' });
    const invalidKind = await call('PUT', threadPath, {
      bearer: member.bearer,
      key: crypto.randomUUID(),
      body: { kind: 'nope' },
    });
    expect(invalidKind.response.status).toBe(400);
    expect(invalidKind.value).toMatchObject({ code: 'invalid_request', effect_status: 'not_applied' });
    const unknownField = await call('PUT', threadPath, {
      bearer: member.bearer,
      key: crypto.randomUUID(),
      body: { kind: 'like', extra: true },
    });
    expect(unknownField.response.status).toBe(400);
    expect(unknownField.value).toMatchObject({ code: 'invalid_request', effect_status: 'not_applied' });
    expect(await effects(published.thread)).toEqual(before);

    const narrow = await call('PUT', threadPath, {
      bearer: member.narrow,
      key: crypto.randomUUID(),
      body: { kind: 'sad' },
    });
    expect(narrow.response.status).toBe(403);
    expect(narrow.value).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
    expect(await effects(published.thread)).toEqual(before);
    const narrowRead = await call('GET', `/v1/threads/${published.thread}`, { bearer: member.narrow });
    expect(narrowRead.response.status).toBe(200);
    expect(narrowRead.value?.thread).toHaveProperty('viewerReaction');

    for (const [method, path] of [
      ['PUT', `/v1/threads/${hidden.thread}/reaction`],
      ['DELETE', `/v1/threads/${hidden.thread}/reaction`],
      ['PUT', `/v1/posts/${hidden.post}/reaction`],
      ['DELETE', `/v1/posts/${hidden.post}/reaction`],
    ] as const) {
      for (const bearer of [member.bearer, author.bearer]) {
        const deniedBefore = await effects(path.includes(hidden.thread) ? hidden.thread : hidden.post);
        const denied = await call(method, path, {
          bearer,
          key: crypto.randomUUID(),
          ...(method === 'PUT' ? { body: { kind: 'like' } } : {}),
        });
        expect(denied.response.status).toBe(403);
        expect(denied.value).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
        expect(await effects(path.includes(hidden.thread) ? hidden.thread : hidden.post)).toEqual(deniedBefore);
      }
    }
  },
);

test.serial(
  "a post page's viewer reactions cost one statement per page, not per post, as posts and reactions grow",
  async () => {
    const restored = await call('PUT', `/v1/posts/${published.posts[0]}/reaction`, {
      bearer: member.bearer,
      key: crypto.randomUUID(),
      body: { kind: 'laugh' },
    });
    expect(restored.response.status).toBe(200);
    const viewerRoute = routeOf(member.accountId)!;
    const population: Population = {
      name: `reaction-viewer-${crypto.randomUUID()}`,
      hotPartition: partitionOf(viewerRoute),
      hotShare: 0,
      rows: ({ route }) => {
        const actorId = newId(route);
        const targetRoute = (route + 1) % 65_536;
        return {
          'content.reaction': [
            {
              route,
              actor_account_id: actorId,
              target_kind: 'post',
              target_route: targetRoute,
              target_id: newId(targetRoute),
              kind: 'like',
              updated_at: '2026-10-25T00:00:00Z',
            },
          ],
        };
      },
    };
    await seed(db, { ...population, name: `${population.name}-background` }, { from: 0, to: 4096 });
    const report = await checkGrowth(db, {
      name: 'Post page viewer reactions',
      scales: [256, 1024, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      repetitions: 1,
      async grow(database, scale, previous) {
        await seed(database, population, { from: previous, to: scale });
      },
      async operation() {
        const trace = observeSql(db.pool);
        try {
          const page = await call('GET', `/v1/threads/${published.thread}/posts?limit=100`, { bearer: member.bearer });
          expect(page.response.status).toBe(200);
          const posts = page.value?.posts as { id: string; viewerReaction: string | null }[];
          expect(posts).toHaveLength(published.posts.length);
          expect(posts.map((post) => post.viewerReaction)).toEqual(['laugh', null, null, null]);
          expect(trace.records.filter((record) => /\bcontent\.reaction\b/.test(record.statement))).toHaveLength(1);
        } finally {
          await trace.close();
        }
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
    for (const sample of report.samples) {
      const relations = sample.cost.relations;
      expect(relations).toBeDefined();
      const reaction = relations?.['content.reaction'];
      expect(reaction).toBeDefined();
      expect(reaction?.sequentialScans).toBe(0);
      expect(sample.cost.statements).toBe(report.samples[0]!.cost.statements);
      expect(sample.cost.rows).toBe(report.samples[0]!.cost.rows);
    }
  },
);
