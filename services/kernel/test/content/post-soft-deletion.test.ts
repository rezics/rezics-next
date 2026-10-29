import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { createAuthService } from '@rezics/auth';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { readAccount } from '../../src/access/account-data.ts';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { clearErasedPostRevisions } from '../../src/content/erased-post-cleanup.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase, checkGrowth, seed, type Population } from '../support/growth.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createAuthorItemEffect } from '../../src/content/author-item-index.ts';
import { observeSql } from './support/sql-observer.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { assertSetupResponse } from './support/setup-response.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const route = 0x6b21;
let now = new Date();
const day = 86400000;
const routeKey = new Uint8Array(32).fill(7);
const author = newId(route);
const other = newId(0x7311);
const moderator = newId(0x7311);
const suspended = newId(0x7311);
const actions = ['post:erase', 'post:read', 'thread:read', 'board:read', 'moderation:takedown', 'account:read'];
const body = Buffer.from(serializeDocument(fromPlainText('Authored sentinel')));
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let app: ReturnType<typeof createKernel>;
let authPool: Pool;
let observer: ReturnType<typeof observeSql>;
const bearers = new Map<string, string>();
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
const authDatabase = `post_soft_delete_auth_${process.pid}`;

beforeAll(async () => {
  db = await openGrowthDatabase();
  observer = observeSql(db.pool);
  const authUrl = new URL(db.url);
  authUrl.pathname = `/${authDatabase}`;
  await db.admin.query(`CREATE DATABASE ${authDatabase}`);
  const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
  migrate(authUrl.toString());
  authPool = new Pool({ connectionString: authUrl.toString() });
  signingKey = (await generateKeyPair('ES256', { extractable: true })).privateKey;
  const signing = {
    ...(await exportJWK(signingKey)),
    kid: 'author-delete',
    alg: 'ES256',
  };
  const issuer = 'https://author-delete.auth.test';
  const password = 'correct horse battery staple';
  const approvals = new Set([author, other, moderator, suspended]);
  const auth = await createAuthService({
    database: authPool,
    issuer,
    audience: 'https://api.rezics.test',
    secret: 'author-delete-test-only-secret-at-least-32-bytes',
    signing: { activeKid: signing.kid, privateKeys: [signing] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        const account = await readAccount(db.admin, routeOf(id)!, id);
        return (
          account && {
            accountId: id,
            kind: account.kind,
            state: account.state,
            authnEpoch: Number(account.minimumAuthnEpoch),
            automated: false,
          }
        );
      },
      async authorizeProvisioning(reference) {
        if (!approvals.delete(reference)) throw new Error('No fixture provisioning approval');
        return { accountId: reference };
      },
    }),
  });
  await auth.internal.registerClient({ clientId: 'web', firstParty: true, scopes: actions });
  for (const id of [author, other, moderator, suspended]) {
    await db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
      VALUES ($1,$2,'actor','pending',$2)`,
      [routeOf(id), id],
    );
    await auth.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
    await db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
      routeOf(id),
      id,
    ]);
    const signInRequest = new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: {
        origin: issuer,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(randomUUID()),
      },
      body: JSON.stringify({ email: `${id}@example.test`, password, client_id: 'web', scope: actions }),
    });
    const signed = await assertSetupResponse(await auth.handler(signInRequest), signInRequest, 200);
    expect(signed.status).toBe(200);
    const cookie = signed.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const tokenRequest = new Request(`${issuer}/token`, {
      method: 'POST',
      headers: {
        origin: issuer,
        'content-type': 'application/json',
        cookie,
        'idempotency-key': JSON.stringify(randomUUID()),
      },
      body: '{}',
    });
    const issued = await assertSetupResponse(await auth.handler(tokenRequest), tokenRequest, 200);
    expect(issued.status).toBe(200);
    bearers.set(id, ((await issued.json()) as { access_token: string }).access_token);
  }
  app = createKernel({
    pool: db.pool,
    clock: () => now,
    routeKey,
    writeRate: createWriteRateLimiter({
      secret: 'author-delete-test-only-rate-secret-at-least-32-bytes',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 60 } } }),
    }),
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience: 'https://api.rezics.test',
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: (url, init) => auth.handler(new Request(url, init)),
        },
      }),
  });
});
afterAll(async () => {
  await observer?.close();
  await authPool?.end();
  if (db) {
    await dropTestDatabase(db.admin, authDatabase);
    await db.close();
  }
});

async function fixture(
  owner = author,
  count = 1,
  parent?: { board: string; thread: string; post: string },
  reviewSubject?: string,
  subjects: string[] = [],
) {
  const board = parent?.board ?? newId(0x6b31),
    thread = parent?.thread ?? newId(route),
    post = newId(route),
    revision = newId(route);
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    if (!parent) {
      await client.query(
        `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
        VALUES ($1,$2,$3,'Board','published',1,$2)`,
        [routeOf(board), board, newId(route)],
      );
      await client.query(
        `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id,kind,review_subject_id)
        VALUES ($1,$2,$3,$4,'Opening title','published',1,$2,$5,$6,$7)`,
        [route, thread, owner, board, post, reviewSubject ? 'review' : 'discussion', reviewSubject ?? null],
      );
    }
    await client.query(
      `INSERT INTO content.post(route,thread_id,post_id,reply_to_post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
      VALUES ($1,$2,$3,$4,$5,$6,'published',1,$6)`,
      [route, thread, post, parent?.post ?? null, owner, revision],
    );
    await client.query(
      `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
      SELECT $1,$2,$3,r.revision_id,$5,sha256($5),'Authored sentinel','CC-BY-4.0',$8::uuid[],$6,'available',$4
      FROM unnest($7::uuid[]) AS r(revision_id)`,
      [
        route,
        thread,
        post,
        revision,
        body,
        board,
        Array.from({ length: count }, (_, index) => (index === 0 ? revision : newId(route))),
        reviewSubject ? [reviewSubject] : subjects,
      ],
    );
    await client.query(
      `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
      VALUES ($1,$2,$3,'content.post.owner','(,)',$2)`,
      [route, post, owner],
    );
    await client.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
      VALUES ($1,$2,$3,'moderation:takedown','(,)',$2)`,
      [route, post, moderator],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { board, thread, post, revision };
}
async function request(
  path: string,
  method = 'GET',
  account: string | null = null,
  key = randomUUID(),
  value?: unknown,
) {
  // Bearer credentials use wall time; only the kernel's domain clock advances.
  const issuedAt = Math.floor(Date.now() / 1000);
  const bearer = account
    ? await new SignJWT({
        ...decodeJwt<Record<string, unknown>>(bearers.get(account)!),
        iat: issuedAt,
        exp: issuedAt + 300,
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'author-delete', typ: 'at+jwt' })
        .sign(signingKey)
    : null;
  return app.handle(
    new Request(`http://kernel.test/v1${path}`, {
      method,
      headers: {
        ...(account ? { authorization: `Bearer ${bearer}` } : {}),
        ...(method !== 'GET' ? { 'Idempotency-Key': JSON.stringify(key) } : {}),
        ...(value === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }),
  );
}

async function revisions(post: string) {
  return (
    await db.admin.query('SELECT * FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY revision_id', [
      route,
      post,
    ])
  ).rows;
}

test('an author deletes a post, it disappears from every read at once, and restoring it within 30 days brings back the same revisions', async () => {
  now = new Date();
  const f = await fixture(author, 3);
  const before = await revisions(f.post);
  expect((await request(`/posts/${f.post}`, 'DELETE', author)).status).toBe(204);
  const removed = await (await request(`/posts/${f.post}`)).json();
  expect(removed.post).toMatchObject({ removed: true, body: null });
  expect((await (await request(`/posts/${f.post}/revisions`)).json()).revisions).toEqual([]);
  expect((await request(`/posts/${f.post}/revisions/${f.revision}`)).status).toBe(404);
  expect((await request(`/posts/${f.post}:restore`, 'POST', other)).status).toBe(404);
  expect((await request(`/posts/${newId(route)}:restore`, 'POST', author)).status).toBe(404);
  const cleanup = await clearErasedPostRevisions(db.pool, { postId: f.post }, Date.now() + 10000);
  expect(cleanup.clearedRevisions).toBe(0);
  expect(await revisions(f.post)).toEqual(before);
  now = new Date(now.getTime() + 29 * day);
  const key = randomUUID();
  const restored = await request(`/posts/${f.post}:restore`, 'POST', author, key);
  expect(restored.status).toBe(204);
  expect((await request(`/posts/${f.post}:restore`, 'POST', author, key)).status).toBe(204);
  expect(await revisions(f.post)).toEqual(before);
  expect((await (await request(`/posts/${f.post}`)).json()).post.removed).toBeUndefined();
  expect((await request(`/posts/${f.post}/revisions/${f.revision}`)).status).toBe(200);
  expect(
    (
      await db.admin.query('SELECT security_revision::text FROM content.post WHERE route=$1 AND post_id=$2', [
        route,
        f.post,
      ])
    ).rows[0].security_revision,
  ).toBe('3');
  expect(
    (
      await db.admin.query(
        "SELECT data FROM core.outbox WHERE partition_no=$1 AND type='com.rezics.content.post.restored.v1' AND subject=$2",
        [partitionOf(route), f.post],
      )
    ).rows,
  ).toEqual([{ data: { postId: f.post, securityRevision: '3' } }]);
});

test("a deleted post's revisions are purged only after 30 days by bounded durable work, and it cannot be restored after", async () => {
  now = new Date();
  const f = await fixture(author, 205);
  expect((await request(`/posts/${f.post}`, 'DELETE', author)).status).toBe(204);
  expect((await clearErasedPostRevisions(db.pool, { postId: f.post }, Date.now() + 10000)).clearedRevisions).toBe(0);
  now = new Date(now.getTime() + 30 * day);
  expect((await request(`/posts/${f.post}:restore`, 'POST', author)).status).toBe(404);
  const modulePath = '../../src/content/deleted-post-purge.ts';
  const { purgeDeletedPostPage } = await import(modulePath);
  now = new Date(now.getTime() + 1);
  const result = await purgeDeletedPostPage(db.pool, route, now, Date.now() + 10000);
  expect(result.postIds).toContain(f.post);
  expect(result.postIds.length).toBeLessThanOrEqual(100);
  const rows = await revisions(f.post);
  expect(rows).toHaveLength(205);
  expect(
    rows.every(
      (r) => r.body === null && r.body_sha256 === null && r.search_text === null && r.availability === 'erased',
    ),
  ).toBe(true);
  expect((await request(`/posts/${f.post}:restore`, 'POST', author)).status).toBe(404);
  expect((await clearErasedPostRevisions(db.pool, { postId: f.post }, Date.now() + 10000)).clearedRevisions).toBe(0);
});

test('restoring a review whose slot now holds another live review answers 409', async () => {
  now = new Date();
  const subject = newId(route);
  const f = await fixture(author, 1, undefined, subject);
  expect((await request(`/posts/${f.post}`, 'DELETE', author)).status).toBe(204);
  const replacement = newId(route);
  await db.admin.query(
    `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,kind,review_subject_id,review_live)
    VALUES ($1,$2,$3,$4,'Replacement','published',1,$2,'review',$5,true)`,
    [route, replacement, author, f.board, subject],
  );
  expect((await request(`/posts/${f.post}:restore`, 'POST', author)).status).toBe(409);
  expect((await (await request(`/posts/${f.post}`)).json()).post.removed).toBe(true);
});

test('moderation keeps immediate purge without admitting a denied caller through receipt fallback', async () => {
  now = new Date();
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$2,'account:read','(,)',$2)`,
    [routeOf(other), other],
  );
  const f = await fixture(author, 3);
  const before = await revisions(f.post);
  expect((await request(`/posts/${f.post}`, 'DELETE', author)).status).toBe(204);
  expect(
    (await request(`/posts/${f.post}:erase`, 'POST', other, randomUUID(), { reason: 'Denied erasure' })).status,
  ).toBe(403);
  expect(await revisions(f.post)).toEqual(before);
  expect((await request(`/posts/${f.post}:restore`, 'POST', author)).status).toBe(204);
  expect((await request(`/posts/${f.post}`, 'DELETE', author)).status).toBe(204);
  // This existing owner grant reaches the moderation route; its grant policy is unchanged.
  expect(
    (await request(`/posts/${f.post}:erase`, 'POST', author, randomUUID(), { reason: 'Permanent erasure' })).status,
  ).toBe(200);
  expect((await clearErasedPostRevisions(db.pool, { postId: f.post }, Date.now() + 10000)).clearedRevisions).toBe(3);
  expect((await request(`/posts/${f.post}:restore`, 'POST', author)).status).toBe(404);
});

test('post delete and restore stay bounded', async () => {
  now = new Date();
  const neighbour = await fixture();
  const population: Population = {
    name: 'soft-delete-neighbours',
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows: () => {
      const post = newId(route),
        revision = newId(route);
      return {
        'content.post': [
          {
            route,
            post_id: post,
            thread_id: neighbour.thread,
            author_account_id: author,
            head_revision_id: revision,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: revision,
          },
        ],
        'content.revision': [
          {
            route,
            post_id: post,
            thread_id: neighbour.thread,
            revision_id: revision,
            body,
            body_sha256: createHash('sha256').update(body).digest(),
            search_text: 'Neighbour',
            licence: 'CC-BY-4.0',
            subject_ids: [],
            board_id: neighbour.board,
            availability: 'available',
            recorded_transaction_id: revision,
          },
        ],
      };
    },
  };
  let probe: Awaited<ReturnType<typeof fixture>>;
  let warm: Awaited<ReturnType<typeof fixture>>;
  const report = await checkGrowth(db, {
    name: 'post delete and restore stay bounded',
    scales: [64, 256, 1024],
    repetitions: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_db, scale, previous) {
      await seed(db, population, { from: previous, to: scale });
      probe = await fixture(author, 3, neighbour);
      warm = await fixture(author, 3, neighbour);
    },
    async warmup() {
      expect((await request(`/posts/${warm.post}`, 'DELETE', author)).status).toBe(204);
      expect((await request(`/posts/${warm.post}:restore`, 'POST', author)).status).toBe(204);
    },
    async operation() {
      expect((await request(`/posts/${probe.post}`, 'DELETE', author)).status).toBe(204);
      expect((await request(`/posts/${probe.post}:restore`, 'POST', author)).status).toBe(204);
    },
  });
  expect(report.samples.map((s) => s.scale)).toEqual([64, 256, 1024]);
});

test('deleted post purge selection stays bounded', async () => {
  const { default: page } = await import('../../src/content/page-deleted-posts.sql');
  const { purgeDeletedPostPage } = await import('../../src/content/deleted-post-purge.ts');
  now = new Date();
  const dueAt = new Date(now.getTime() - 31 * day).toISOString();
  const parent = await fixture();
  const pending: string[] = [];
  const population: Population = {
    name: 'purged-neighbours',
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const post = newId(route),
        revision = newId(route);
      const completed = ordinal % 2 === 0;
      return {
        'content.post': [
          {
            route,
            post_id: post,
            thread_id: parent.thread,
            author_account_id: author,
            head_revision_id: revision,
            visibility: 'published',
            security_revision: 2,
            availability: 'erased',
            deleted_at: completed ? dueAt : now.toISOString(),
            purge_started_at: completed ? dueAt : null,
            purge_completed: completed,
            recorded_transaction_id: revision,
          },
        ],
        'content.revision': [
          {
            route,
            post_id: post,
            thread_id: parent.thread,
            revision_id: revision,
            body: completed ? null : body,
            body_sha256: completed ? null : createHash('sha256').update(body).digest(),
            search_text: completed ? null : 'Unexpired',
            licence: 'CC-BY-4.0',
            subject_ids: [],
            board_id: parent.board,
            availability: completed ? 'erased' : 'available',
            recorded_transaction_id: revision,
          },
        ],
      };
    },
  };
  for (let i = 0; i < 101; i++) {
    const f = await fixture(author, 1, parent);
    await db.admin.query(
      "UPDATE content.post SET availability='erased',deleted_at=$3,security_revision=2 WHERE route=$1 AND post_id=$2",
      [route, f.post, dueAt],
    );
    pending.push(f.post);
  }
  const report = await checkGrowth(db, {
    name: 'deleted post purge selection stays bounded',
    scales: [64, 256, 1024],
    repetitions: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_db, scale, previous) {
      await seed(db, population, { from: previous, to: scale });
    },
    async operation() {
      const rows = await page.run(db.pool, { route, at: now.toISOString() });
      expect(rows).toHaveLength(100);
    },
  });
  expect(report.samples.map((s) => s.scale)).toEqual([64, 256, 1024]);
  const first = await purgeDeletedPostPage(db.pool, route, now, Date.now() + 20000);
  expect(first.postIds).toHaveLength(100);
  const second = await purgeDeletedPostPage(db.pool, route, now, Date.now() + 20000);
  expect(second.postIds).toHaveLength(1);
  expect([...first.postIds, ...second.postIds].sort()).toEqual(pending.sort());
  expect((await purgeDeletedPostPage(db.pool, route, now, Date.now() + 20000)).postIds).toEqual([]);
});

test('restored reply events re-admit author items and delayed erasure cannot remove them', async () => {
  now = new Date();
  const parent = await fixture();
  const reply = await fixture(author, 2, parent);
  expect((await request(`/posts/${reply.post}`, 'DELETE', author)).status).toBe(204);
  expect((await request(`/posts/${reply.post}:restore`, 'POST', author)).status).toBe(204);
  const events = (
    await db.admin.query(
      `SELECT id::text,type,data,position::text,epoch FROM core.outbox
    WHERE partition_no=$1 AND subject=$2 ORDER BY position`,
      [partitionOf(route), reply.post],
    )
  ).rows;
  const effect = createAuthorItemEffect(db.pool);
  const convert = (row: (typeof events)[number]) => ({
    specversion: '1.0' as const,
    id: row.id,
    source: `urn:rezics:log:${partitionOf(route)}.${row.epoch}`,
    type: row.type,
    subject: reply.post,
    time: now.toISOString(),
    datacontenttype: 'application/json' as const,
    sequence: row.position.padStart(19, '0'),
    data: row.data,
  });
  await effect.run(convert(events[1]!));
  await effect.run(convert(events[0]!));
  await effect.run(convert(events[1]!));
  const listed = await (await request(`/accounts/${author}/posts`, 'GET', author)).json();
  expect(listed.posts.map((p: { id: string }) => p.id)).toContain(reply.post);
  expect(listed.posts.map((p: { id: string }) => p.id)).not.toContain(parent.post);
});

test('concurrent expired-post cleanup clears each revision once', async () => {
  now = new Date();
  const f = await fixture(author, 205);
  expect((await request(`/posts/${f.post}`, 'DELETE', author)).status).toBe(204);
  const afterWindow = () => new Date(now.getTime() + 31 * day);
  const outcomes = await Promise.all(
    Array.from({ length: 2 }, () =>
      clearErasedPostRevisions(db.pool, { postId: f.post }, Date.now() + 20000, afterWindow),
    ),
  );
  expect(outcomes.reduce((sum, outcome) => sum + outcome.clearedRevisions, 0)).toBe(205);
  expect(
    (await revisions(f.post)).every((row) => row.body === null && row.body_sha256 === null && row.search_text === null),
  ).toBe(true);
  // Once fenced, even an earlier trusted clock cannot make the post restorable.
  expect((await request(`/posts/${f.post}:restore`, 'POST', author)).status).toBe(404);
});

test('durable purge resumes after a recorded revision page without rescanning it', async () => {
  now = new Date();
  const f = await fixture(author, 205);
  expect((await request(`/posts/${f.post}`, 'DELETE', author)).status).toBe(204);
  const recorded = new Map<string, unknown>();
  const executed: string[] = [];
  let crash = true;
  const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    if (recorded.has(name)) return recorded.get(name) as T;
    if (name.includes(':revisions:') && executed.filter((n) => n.includes(':revisions:')).length === 1 && crash) {
      crash = false;
      throw new Error('Simulated worker crash after the first revision page');
    }
    executed.push(name);
    const output = await action();
    recorded.set(name, output);
    return output;
  };
  const afterWindow = () => new Date(now.getTime() + 31 * day);
  await expect(
    clearErasedPostRevisions(db.pool, { postId: f.post }, Date.now() + 20000, afterWindow, step),
  ).rejects.toThrow('Simulated worker crash');
  expect((await revisions(f.post)).filter((r) => r.body === null)).toHaveLength(100);
  expect((await request(`/posts/${f.post}:restore`, 'POST', author)).status).toBe(404);
  const resumed = await clearErasedPostRevisions(db.pool, { postId: f.post }, Date.now() + 20000, afterWindow, step);
  expect(resumed).toEqual({ pageSizes: [100, 100, 5], clearedRevisions: 205 });
  expect(executed.filter((n) => n.includes(':revisions:'))).toHaveLength(3);
  expect(new Set(executed).size).toBe(executed.length);
});

test('the hourly durable sweep purges an expired post even without an erased event', async () => {
  const { startWorker } = await import('../../src/worker.ts');
  const { createWorkClient } = await import('../../src/work/client.ts');
  const { workerTestEnv } = await import('../support/worker-env.ts');
  now = new Date();
  const f = await fixture(author, 205);
  await db.admin.query(
    "UPDATE content.post SET availability='erased',security_revision=2,deleted_at=$3 WHERE route=$1 AND post_id=$2",
    [route, f.post, new Date(now.getTime() - 31 * day)],
  );
  const runtime = await startWorker(
    { databaseUrl: db.url, poolSize: 8, executorId: `soft-deletion-${process.pid}`, clock: () => now },
    undefined,
    workerTestEnv({ CONTENT_TEST_COLLECTION_PARTITIONS: String(partitionOf(route)) }),
  );
  const client = await createWorkClient(db.url);
  try {
    const id = `soft-deletion-sweep-${randomUUID()}`;
    const handle = await client.enqueue(
      { workflowName: 'content.collect', queueName: 'maintenance', workflowID: id },
      new Date(),
      null,
    );
    await handle.getResult();
    expect(
      (await revisions(f.post)).every((r) => r.body === null && r.body_sha256 === null && r.search_text === null),
    ).toBe(true);
    const recorded = await db.admin.query(
      "SELECT 1 FROM dbos.operation_outputs WHERE function_name='content.deletedPostPurge.step' LIMIT 1",
    );
    expect(recorded.rows).toHaveLength(1);
    expect((await request(`/posts/${f.post}:restore`, 'POST', author)).status).toBe(404);
  } finally {
    await client.close();
    await runtime.stop();
  }
});

test('soft delete retains its authorized receipt replay while restore requires current authority', async () => {
  now = new Date();
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$2,'account:read','(,)',$2)`,
    [routeOf(author), author],
  );
  const f = await fixture();
  const key = randomUUID();
  const first = await request(`/posts/${f.post}`, 'DELETE', author, key);
  expect(first.status).toBe(204);
  await db.admin.query(
    "DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role='content.post.owner'",
    [route, f.post, author],
  );
  const replay = await request(`/posts/${f.post}`, 'DELETE', author, key);
  expect(replay.status).toBe(204);
  expect(first.headers.get('rezics-session-token')).not.toBeNull();
  expect(replay.headers.get('rezics-session-token')).toBe(first.headers.get('rezics-session-token'));
  expect((await request(`/posts/${f.post}`, 'DELETE', author)).status).toBe(403);
  expect((await request(`/posts/${f.post}:restore`, 'POST', author)).status).toBe(404);
  expect((await revisions(f.post))[0].body).toEqual(body);
});

test('restoring an opening post re-admits board, subject, author and reaction reads', async () => {
  now = new Date();
  const subject = newId(route);
  const f = await fixture(author, 3, undefined, undefined, [subject]);
  await db.admin.query(
    "INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id) VALUES ($1,$2,'schema:Book',$2)",
    [route, subject],
  );
  await db.admin.query(
    `INSERT INTO content.board_thread(route,board_id,thread_id,created_at,source_epoch,source_position)
    VALUES ($1,$2,$3,now(),1,1)`,
    [routeOf(f.board), f.board, f.thread],
  );
  await db.admin.query(
    `INSERT INTO content.subject_thread(route,subject_id,thread_route,thread_id,place_id,kind,last_activity_at,source_epoch,source_position)
    VALUES ($1,$2,$1,$3,$4,'discussion',now(),1,1)`,
    [route, subject, f.thread, GLOBAL_CONTEXT],
  );
  await db.admin.query(
    `INSERT INTO content.author_item(route,author_account_id,item_kind,item_id,thread_id,thread_kind,created_at,source_epoch,source_position)
    VALUES ($1,$2,'thread',$3,$3,'discussion',now(),1,1)`,
    [routeOf(author), author, f.thread],
  );
  await db.admin.query(
    `INSERT INTO content.reaction_total(route,target_id,kind,count,source_epoch,source_position)
    VALUES ($1,$2,'like',3,1,1)`,
    [route, f.post],
  );
  const paths = [
    `/boards/${f.board}/threads`,
    `/subjects/${subject}/threads?place=${GLOBAL_CONTEXT}&kind=discussion`,
    `/accounts/${author}/threads`,
  ];
  const listed = async (path: string) => (await (await request(path, 'GET', author)).json()).threads;
  for (const path of paths) expect((await listed(path)).map((t: { id: string }) => t.id)).toContain(f.thread);
  const posts = async () => (await (await request(`/threads/${f.thread}/posts`)).json()).posts;
  expect((await posts())[0].reactions).toEqual({ like: 3 });
  expect((await request(`/posts/${f.post}`, 'DELETE', author)).status).toBe(204);
  for (const path of paths) {
    const threads = await listed(path);
    if (path.startsWith('/accounts/')) expect(threads.map((t: { id: string }) => t.id)).not.toContain(f.thread);
    else {
      expect(threads).toHaveLength(1);
      expect(threads[0].title).toBeNull();
      expect(threads[0].firstPost).toMatchObject({ removed: true, body: null });
    }
  }
  expect((await posts())[0]).toMatchObject({ id: f.post, removed: true, body: null });
  expect((await posts())[0].reactions).toBeUndefined();
  // An unrelated native grant never substitutes for the exact author's identity.
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,'post:erase','(,)',$2)`,
    [route, f.post, other],
  );
  expect((await request(`/posts/${f.post}:restore`, 'POST', other)).status).toBe(404);
  expect((await request(`/posts/${f.post}:restore`, 'POST', author)).status).toBe(204);
  for (const path of paths) expect((await listed(path)).map((t: { id: string }) => t.id)).toContain(f.thread);
  expect((await posts())[0].reactions).toEqual({ like: 3 });
});

test('restoring a review with an empty slot makes that same review live again', async () => {
  now = new Date();
  const f = await fixture(author, 2, undefined, newId(route));
  const before = await revisions(f.post);
  expect((await request(`/posts/${f.post}`, 'DELETE', author)).status).toBe(204);
  expect((await request(`/posts/${f.post}:restore`, 'POST', author)).status).toBe(204);
  expect(
    (await db.admin.query('SELECT review_live FROM content.thread WHERE route=$1 AND thread_id=$2', [route, f.thread]))
      .rows[0].review_live,
  ).toBe(true);
  expect(await revisions(f.post)).toEqual(before);
});
