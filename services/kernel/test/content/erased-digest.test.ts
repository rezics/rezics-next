import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { clearErasedPostRevisions } from '../../src/content/erased-post-cleanup.ts';
import readRevision from '../../src/content/read-revision.sql';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase } from '../support/growth.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let app: ReturnType<typeof createKernel>;
let sign: (accountId: string) => Promise<string>;

beforeAll(async () => {
  db = await openGrowthDatabase();
  const pair = await generateKeyPair('ES256');
  const publicKey = { ...(await exportJWK(pair.publicKey)), kid: 'erased-digest', alg: 'ES256' };
  const issuer = 'https://erased-digest.auth.test';
  const audience = 'https://erased-digest.api.test';
  const actions = ['thread:create', 'thread:read', 'board:read', 'post:read', 'post:revise', 'post:erase'];
  sign = (accountId) =>
    new SignJWT({
      client_id: 'web',
      scope: actions.join(' '),
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'erased-digest', typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(accountId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(pair.privateKey);
  app = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(17),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(18)]]) },
    writeRate: createWriteRateLimiter({ secret: 'erased-digest-test-only-secret-at-least-32-bytes' }),
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          async fetch() {
            return Response.json({ keys: [publicKey] });
          },
        },
      }),
  });
});
afterAll(async () => db?.close());

async function call(bearer: string, method: string, path: string, body?: unknown, key = randomUUID()) {
  return app.handle(
    new Request(`http://kernel.test/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(method === 'GET' ? {} : { 'Idempotency-Key': JSON.stringify(key) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function fixture() {
  const author = newId(0x7311);
  const board = newId(0x4321);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     VALUES ($1,$2,'actor','active',$2)`,
    [routeOf(author), author],
  );
  await db.admin.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Digest board','published',1,$2)`,
    [routeOf(board), board, newId(0x6789)],
  );
  for (const action of ['thread:create', 'board:read'])
    await db.admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES ($1,$2,$3,$4,'(,)',$2)`,
      [routeOf(board), board, author, action],
    );
  const bearer = await sign(author);
  const input = {
    title: 'Digest thread',
    body: fromPlainText('First secret'),
    licence: 'CC-BY-4.0',
    subjectIds: [],
    boardId: board,
    visibility: 'published',
  };
  const key = randomUUID();
  const response = await call(bearer, 'POST', '/threads', input, key);
  expect(response.status).toBe(201);
  const { thread } = await response.json();
  return { bearer, input, key, thread: thread.id as string, post: thread.firstPost.id as string };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function stored(f: Fixture) {
  const result = await db.admin.query(
    'SELECT * FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY recorded_at,revision_id',
    [routeOf(f.post), f.post],
  );
  return result.rows;
}
async function revise(f: Fixture, text: string, key = randomUUID()) {
  const input = { body: fromPlainText(text) };
  const response = await call(f.bearer, 'POST', `/posts/${f.post}/revisions`, input, key);
  expect(response.status).toBe(200);
  return { input, key, value: (await response.json()).post };
}
async function erase(f: Fixture) {
  const response = await call(f.bearer, 'DELETE', `/posts/${f.post}`);
  expect(response.status).toBe(204);
}
const cleanup = (f: Fixture) =>
  clearErasedPostRevisions(
    db.pool,
    { postId: f.post },
    Date.now() + 10_000,
    () => new Date(Date.now() + 31 * 86_400_000),
  );

test('physical erasure clears each erased revision body and digest together and preserves immutable metadata', async () => {
  const f = await fixture();
  await revise(f, 'Second secret');
  await revise(f, 'Third secret');
  const before = await stored(f);
  expect(before).toHaveLength(3);
  await erase(f);
  expect(await stored(f)).toEqual(before);
  const page = await call(f.bearer, 'GET', `/threads/${f.thread}/posts`);
  expect(page.status).toBe(200);
  expect((await page.json()).posts).toMatchObject([{ id: f.post, body: null, sha256: null, removed: true }]);
  expect(await cleanup(f)).toEqual({ pageSizes: [3], clearedRevisions: 3 });
  expect(await stored(f)).toEqual(
    before.map((row) => ({ ...row, body: null, body_sha256: null, search_text: null, availability: 'erased' })),
  );
  expect(await cleanup(f)).toEqual({ pageSizes: [], clearedRevisions: 0 });
  for (const row of before) {
    const selected = await readRevision.run(db.admin, {
      route: routeOf(f.post)!,
      thread_id: f.thread,
      post_id: f.post,
      revision_id: row.revision_id,
    });
    expect(selected).toMatchObject([{ body: null, body_sha256: null, availability: 'erased' }]);
  }
});

test('database refuses unpaired digests and any revision change except tombstone-authorized physical erasure', async () => {
  const f = await fixture();
  const [original] = await stored(f);
  const update = (set: string, values: unknown[] = []) =>
    db.admin.query(`UPDATE content.revision SET ${set} WHERE route=$1 AND revision_id=$2`, [
      routeOf(f.post),
      original.revision_id,
      ...values,
    ]);
  for (const [body, digest, availability, search] of [
    [null, original.body_sha256, 'erased', null],
    [original.body, null, 'available', 'First secret'],
    [original.body, Buffer.alloc(32), 'available', 'First secret'],
  ]) {
    await expect(
      db.admin.query(
        `INSERT INTO content.revision
         (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'CC-BY-4.0','{}',$8,$9,$4)`,
        [
          routeOf(f.post),
          f.thread,
          f.post,
          newId(routeOf(f.post)!),
          body,
          digest,
          search,
          f.input.boardId,
          availability,
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  }
  await expect(update("body=NULL,body_sha256=NULL,search_text=NULL,availability='erased'")).rejects.toMatchObject({
    code: '23514',
  });
  await erase(f);
  for (const set of [
    "body=NULL,search_text=NULL,availability='erased'",
    'body_sha256=NULL',
    "body=NULL,body_sha256=NULL,search_text=NULL,availability='erased',licence='MIT'",
  ])
    await expect(update(set)).rejects.toMatchObject({ code: '23514' });
  await update("body=NULL,body_sha256=NULL,search_text=NULL,availability='erased'");
  const forbidden: [string, unknown[]][] = [
    ["licence='MIT'", []],
    ['body_sha256=$3', [original.body_sha256]],
    [
      "body=$4,body_sha256=$3,search_text='First secret',availability='available'",
      [original.body_sha256, original.body],
    ],
    ['body=NULL,body_sha256=NULL', []],
    ['revision_id=$3', [newId(routeOf(f.post)!)]],
  ];
  for (const [set, values] of forbidden) await expect(update(set, values)).rejects.toMatchObject({ code: '23514' });
  await expect(
    db.admin.query('DELETE FROM content.revision WHERE route=$1 AND revision_id=$2', [
      routeOf(f.post),
      original.revision_id,
    ]),
  ).rejects.toMatchObject({ code: '23514' });
  expect(await stored(f)).toEqual([
    { ...original, body: null, body_sha256: null, search_text: null, availability: 'erased' },
  ]);
});

test('reads, command replays and revisions of live posts preserve their canonical digests', async () => {
  const f = await fixture();
  const [original] = await stored(f);
  const digest = createHash('sha256').update(serializeDocument(f.input.body)).digest('hex');
  expect(original.body_sha256.toString('hex')).toBe(digest);
  const replay = await call(f.bearer, 'POST', '/threads', f.input, f.key);
  expect(replay.status).toBe(201);
  expect((await replay.json()).thread.firstPost).toMatchObject({ id: f.post, sha256: digest });
  expect(await cleanup(f)).toEqual({ pageSizes: [], clearedRevisions: 0 });
  expect(await stored(f)).toEqual([original]);
  const edited = await revise(f, 'Live edited secret');
  const editedDigest = createHash('sha256').update(serializeDocument(edited.input.body)).digest('hex');
  expect(edited.value.sha256).toBe(editedDigest);
  const revisionReplay = await call(f.bearer, 'POST', `/posts/${f.post}/revisions`, edited.input, edited.key);
  expect(revisionReplay.status).toBe(200);
  expect((await revisionReplay.json()).post).toMatchObject({
    revisionId: edited.value.revisionId,
    sha256: editedDigest,
  });
  for (const [path, expected] of [
    [`/posts/${f.post}`, editedDigest],
    [`/posts/${f.post}/revisions/${original.revision_id}`, digest],
  ]) {
    const response = await call(f.bearer, 'GET', path!);
    expect(response.status).toBe(200);
    expect((await response.json()).post.sha256).toBe(expected);
  }
  const history = await call(f.bearer, 'GET', `/posts/${f.post}/revisions`);
  expect(history.status).toBe(200);
  expect((await history.json()).revisions.map((row: { sha256: string }) => row.sha256).sort()).toEqual(
    [digest, editedDigest].sort(),
  );
  const after = await stored(f);
  expect(after).toHaveLength(2);
  expect(after[0]).toEqual(original);
  expect(after[1].body_sha256.toString('hex')).toBe(editedDigest);
});
