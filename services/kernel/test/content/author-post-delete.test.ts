import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { createAuthService } from '@rezics/auth';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { readAccount } from '../../src/access/account-data.ts';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { runCommand } from '../../src/command/command.ts';
import { nullErasedRevisionPage } from '../../src/content/erasure-workflow.ts';
import { clearErasedPostRevisions } from '../../src/content/erased-post-cleanup.ts';
import erase from '../../src/content/erase-content.sql';
import nullRevisions from '../../src/content/null-erased-revisions.sql';
import readScope from '../../src/content/read-erasure-scope.sql';
import { createKernel } from '../../src/http/kernel.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  assertGrowth,
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  seed,
  settle,
  type GrowthSample,
  type Population,
} from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { assertSetupResponse } from './support/setup-response.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { SUBJECT_THREAD_EVENT_FIELDS } from '../support/subject-thread-event.ts';

const route = 0x6b21;
const routeKey = new Uint8Array(32).fill(7);
const author = newId(0x7311);
const other = newId(0x7311);
const moderator = newId(0x7311);
const suspended = newId(0x7311);
const actions = ['post:erase', 'post:read', 'thread:read', 'board:read', 'moderation:takedown'];
const body = Buffer.from(serializeDocument(fromPlainText('Authored sentinel')));
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let app: ReturnType<typeof createKernel>;
let authPool: Pool;
let observer: ReturnType<typeof observeSql>;
const bearers = new Map<string, string>();
const authDatabase = `author_delete_auth_${process.pid}`;

beforeAll(async () => {
  db = await openGrowthDatabase();
  observer = observeSql(db.pool);
  const authUrl = new URL(db.url);
  authUrl.pathname = `/${authDatabase}`;
  await db.admin.query(`CREATE DATABASE ${authDatabase}`);
  const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
  migrate(authUrl.toString());
  authPool = new Pool({ connectionString: authUrl.toString() });
  const signing = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
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
    routeKey,
    writeRate: createWriteRateLimiter({ secret: 'author-delete-test-only-rate-secret-at-least-32-bytes' }),
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

async function fixture(owner = author, count = 1, parent?: { board: string; thread: string; post: string }) {
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
        `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id)
        VALUES ($1,$2,$3,$4,'Opening title','published',1,$2,$5)`,
        [route, thread, owner, board, post],
      );
    }
    await client.query(
      `INSERT INTO content.post(route,thread_id,post_id,reply_to_post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
      VALUES ($1,$2,$3,$4,$5,$6,'published',1,$6)`,
      [route, thread, post, parent?.post ?? null, owner, revision],
    );
    await client.query(
      `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
      SELECT $1,$2,$3,r.revision_id,$5,sha256($5),'Authored sentinel','CC-BY-4.0','{}',$6,'available',$4
      FROM unnest($7::uuid[]) AS r(revision_id)`,
      [
        route,
        thread,
        post,
        revision,
        body,
        board,
        Array.from({ length: count }, (_, index) => (index === 0 ? revision : newId(route))),
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
function request(path: string, method = 'GET', account: string | null = null, key = randomUUID()) {
  return app.handle(
    new Request(`http://kernel.test/v1${path}`, {
      method,
      headers: {
        ...(account ? { authorization: `Bearer ${bearers.get(account)!}` } : {}),
        ...(method === 'DELETE' ? { 'Idempotency-Key': JSON.stringify(key) } : {}),
      },
    }),
  );
}
async function cleanup(post: string, after = { at: '-infinity', id: post }) {
  return (
    await runCommand(
      db.pool,
      {
        partition: partitionOf(route),
        receipt: {
          actorAccountId: author,
          kind: 'content.author-erasure.cleanup',
          key: `${post}:${after.at}:${after.id}`,
          digest: createHash('sha256').update(`${post}:${after.at}:${after.id}`).digest(),
        },
      },
      async (tx) => ({
        value: await nullErasedRevisionPage(tx, { route, post_id: post, after_at: after.at, after_id: after.id }),
        events: [
          { type: 'com.rezics.content.moderation.erasure.v1', data: { threadId: post, postIds: [], mediaIds: [] } },
        ],
      }),
    )
  ).value;
}

test('an author deletes their own post: removed slots preserve replies and cleanup clears every revision', async () => {
  const f = await fixture(author, 205);
  const reply = newId(route),
    replyRevision = newId(route);
  await db.admin.query('BEGIN');
  await db.admin.query(
    `INSERT INTO content.post(route,thread_id,post_id,reply_to_post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,$5,$6,'published',1,$6)`,
    [route, f.thread, reply, f.post, other, replyRevision],
  );
  await db.admin.query(
    `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,$5,sha256($5),'Reply','CC-BY-4.0','{}',$6,'available',$4)`,
    [route, f.thread, reply, replyRevision, body, f.board],
  );
  await db.admin.query('COMMIT');
  const beforeRequest = new Request(`http://kernel.test/v1/threads/${f.thread}/posts`);
  const before = await (await assertSetupResponse(await app.handle(beforeRequest), beforeRequest, 200)).json();
  const start = observer.records.length;
  const deleted = await request(`/posts/${f.post}`, 'DELETE', author);
  expect(deleted.status).toBe(204);
  expect(await deleted.text()).toBe('');
  expect(deleted.headers.get(SESSION_HEADER)).not.toBeNull();
  const statements = observer.records.slice(start).map((row) => row.statement);
  expect(statements.filter((sql) => sql === readScope.sql)).toHaveLength(1);
  expect(statements.filter((sql) => sql === erase.sql)).toHaveLength(1);
  expect(statements).not.toContain(nullRevisions.sql);
  expect(
    (
      await db.admin.query(
        'SELECT count(*)::int AS n FROM content.revision WHERE route=$1 AND post_id=$2 AND body IS NOT NULL',
        [route, f.post],
      )
    ).rows[0].n,
  ).toBe(205);
  const after = await (await request(`/threads/${f.thread}/posts`)).json();
  expect(after.posts.map((post: { id: string }) => post.id)).toEqual(
    before.posts.map((post: { id: string }) => post.id),
  );
  expect(after.posts[0]).toMatchObject({ id: f.post, removed: true, body: null });
  expect(after.posts[1]).toMatchObject({ id: reply, parentId: f.post, availability: 'available' });
  expect(JSON.stringify(after.posts[0])).not.toContain('Authored sentinel');
  const thread = await (await request(`/threads/${f.thread}`)).json();
  expect(thread.thread).toMatchObject({ id: f.thread, title: null, firstPost: { removed: true, body: null } });
  expect((await (await request(`/posts/${f.post}`)).json()).post).toMatchObject({ removed: true, body: null });
  expect(await (await request(`/posts/${f.post}/revisions`, 'GET', author)).json()).toEqual({
    revisions: [],
    next: null,
  });
  expect((await request(`/posts/${f.post}/revisions/${f.revision}`, 'GET', author)).status).toBe(404);
  const { pageSizes: sizes } = await clearErasedPostRevisions(
    db.pool,
    { postId: f.post },
    Date.now() + 10_000,
    () => new Date(Date.now() + 31 * 86400000),
  );
  expect(sizes).toEqual([100, 100, 5]);
  expect(
    (
      await db.admin.query(
        `SELECT count(*)::int AS n FROM content.revision WHERE route=$1 AND post_id=$2
    AND (body IS NOT NULL OR search_text IS NOT NULL OR availability <> 'erased')`,
        [route, f.post],
      )
    ).rows[0].n,
  ).toBe(0);
  const stored = await db.admin.query(
    'SELECT * FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY recorded_at,revision_id',
    [route, f.post],
  );
  const replay = await clearErasedPostRevisions(
    db.pool,
    { postId: f.post },
    Date.now() + 10_000,
    () => new Date(Date.now() + 31 * 86400000),
  );
  expect(replay.clearedRevisions).toBe(0);
  expect(
    (
      await db.admin.query(
        'SELECT * FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY recorded_at,revision_id',
        [route, f.post],
      )
    ).rows,
  ).toEqual(stored.rows);
  expect((await request(`/posts/${reply}`)).status).toBe(200);
});

test('another account, a moderator without post:erase, anonymous and suspended accounts delete nothing; replay returns the stored outcome', async () => {
  const f = await fixture();
  const s = await fixture(suspended);
  await db.admin.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
    routeOf(suspended),
    suspended,
  ]);
  for (const [account, target, status] of [
    [other, f.post, 403],
    [moderator, f.post, 403],
    [null, f.post, 401],
    [suspended, s.post, 401],
  ] as const) {
    expect((await request(`/posts/${target}`, 'DELETE', account)).status).toBe(status);
    expect(
      (
        await db.admin.query(
          'SELECT availability,security_revision::text FROM content.post WHERE route=$1 AND post_id=$2',
          [route, target],
        )
      ).rows[0],
    ).toEqual({ availability: 'available', security_revision: '1' });
  }
  const key = randomUUID();
  const deleted = await request(`/posts/${f.post}`, 'DELETE', author, key);
  expect(deleted.status).toBe(204);
  const outcome = (
    await db.admin.query('SELECT position::text FROM core.partition WHERE partition_no=$1', [partitionOf(route)])
  ).rows[0];
  const replay = await request(`/posts/${f.post}`, 'DELETE', author, key);
  expect(replay.status).toBe(204);
  expect(await replay.text()).toBe('');
  expect(replay.headers.get(SESSION_HEADER)).toBe(deleted.headers.get(SESSION_HEADER));
  expect(
    (await db.admin.query('SELECT position::text FROM core.partition WHERE partition_no=$1', [partitionOf(route)]))
      .rows[0],
  ).toEqual(outcome);
});

test('delete is one bounded tombstone and cleanup runs in bounded pages as posts and revisions grow', async () => {
  const neighbour = await fixture();
  const population: Population = {
    name: 'author-delete-neighbours',
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const post = newId(route),
        revision = newId(route),
        account = newId(routeOf(author)!),
        group = newId(routeOf(author)!);
      const position = 1000 + ordinal * 10;
      const grant = {
        route,
        resource_id: post,
        subject_id: author,
        valid: '(,)',
        transaction_id: revision,
      };
      return {
        // Grow the parent relation too, so point reads use its index at every scale.
        'content.thread': [
          {
            route,
            thread_id: post,
            author_account_id: author,
            board_id: neighbour.board,
            title: 'Neighbour thread',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: revision,
          },
        ],
        'content.post': [
          {
            route,
            thread_id: neighbour.thread,
            post_id: post,
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
            thread_id: neighbour.thread,
            post_id: post,
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
        // Unrelated native Access rows keep point probes honest at every scale.
        'access.account': [
          { route: routeOf(account), account_id: account, kind: 'actor', state: 'active', transaction_id: revision },
          { route: routeOf(group), account_id: group, kind: 'organization', state: 'active', transaction_id: revision },
        ],
        'access.membership_inverse': [
          {
            route: routeOf(account),
            account_id: account,
            kind: 'organization',
            group_id: group,
            reservation_id: revision,
            transaction_id: revision,
          },
        ],
        'access.organization_member': [
          {
            route: routeOf(group),
            organization_id: group,
            member_account_id: account,
            role: 'owner',
            valid: '(,)',
            transaction_id: revision,
          },
        ],
        'access.resource_grant': [{ ...grant, action: 'post:erase' }],
        'access.resource_role_grant': [{ ...grant, grant_role: 'content.post.owner' }],
        'access.resource_denial': [{ ...grant, action: 'post:erase', reason: 'resource' }],
        'access.write_rate_counter': [
          {
            route: routeOf(account),
            identity_digest: createHash('sha256').update(account).digest('hex'),
            family: 'content',
            count: 1,
            expires_at: '2099-01-01T00:00:00Z',
          },
        ],
        'core.receipt': [
          {
            partition_no: partitionOf(route),
            principal_kind: 'account',
            principal_id: author,
            command_kind: 'content.post:erase',
            idempotency_key: post,
            request_digest: Buffer.alloc(32),
            epoch: 1,
            position,
            transaction_id: revision,
            response: { postId: post },
          },
        ],
        'core.outbox': [
          {
            partition_no: partitionOf(route),
            position,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: revision,
            type: 'com.rezics.content.post.created.v1',
            subject: post,
            data: {
              threadId: neighbour.thread,
              itemId: post,
              revisionId: revision,
              actorId: author,
              ...SUBJECT_THREAD_EVENT_FIELDS,
            },
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: partitionOf(route),
            transaction_id: revision,
            epoch: 1,
            position,
            principal_kind: 'account',
            principal_id: author,
            client_id: 'web',
          },
        ],
      };
    },
    async finish(admin, range) {
      await admin.query('UPDATE core.partition SET position = GREATEST(position, $2) WHERE partition_no = $1', [
        partitionOf(route),
        1000 + range.to * 10,
      ]);
    },
  };
  let probe: Awaited<ReturnType<typeof fixture>>;
  let warmupProbe: Awaited<ReturnType<typeof fixture>>;
  const pages: GrowthSample[] = [];
  const bounds = { rows: 'constant', statements: 'constant', blocks: 'logarithmic' } as const;
  const report = await checkGrowth(db, {
    name: 'Author post delete',
    rule: 'series',
    // Content Cost: two scope seeks and two tombstone/parent seeks; Access P/Q:
    // two account observations, account/inverse preparation and 13 local/Global formula probes;
    // command C: receipt, basis, outbox and receipt write; one write-rate counter.
    indexProbes: 4 + 2 + 2 + 13 + 4 + 1,
    scales: [256, 1024, 4096],
    bounds,
    repetitions: 1,
    async grow(_database, scale, previous) {
      await seed(db, population, { from: previous, to: scale });
      probe = await fixture(author, 205, neighbour);
      warmupProbe = await fixture(author, 205, neighbour);
      const erased = await fixture(author, 205, neighbour);
      expect((await request(`/posts/${erased.post}`, 'DELETE', author)).status).toBe(204);
      await settle(db, { analyze: true });
      const page = await capture(db, () => cleanup(erased.post));
      expect(page.value).toHaveLength(100);
      pages.push({ scale, cost: costOf(page.capture) });
    },
    async warmup() {
      expect((await request(`/posts/${warmupProbe.post}`, 'DELETE', author)).status).toBe(204);
    },
    async operation() {
      const start = observer.records.length;
      expect((await request(`/posts/${probe.post}`, 'DELETE', author)).status).toBe(204);
      const sql = observer.records.slice(start).map((row) => row.statement);
      expect(sql.filter((statement) => statement === erase.sql)).toHaveLength(1);
      expect(sql).not.toContain(nullRevisions.sql);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  assertGrowth(pages, bounds);
  for (const { cost } of [...report.samples, ...pages]) {
    expect(cost.rows).toBeGreaterThan(0);
    expect(cost.statements).toBeGreaterThan(0);
  }
  const result = await capture(db, () => cleanup(neighbour.post));
  expect(result.value).toEqual([]);
});
