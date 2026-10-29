import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { createAccess } from '../../src/access/index.ts';
import { readBoard, readPost, readThread } from '../../src/content/reads.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { Actor, Access } from '../../src/request/access.ts';
import { capture, checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';

const contentRoute = 0x1234;
const boardRoute = 0x5678;
const author = newId(0x9abc);
const reader = newId(0x9abc);
const subject = newId(0xdef0);
const media = newId(contentRoute);
const actions = ['board:read', 'thread:read', 'post:read'];
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
const retained = Buffer.from(
  JSON.stringify({
    version: 'rezics-document-v1',
    profile: 'text',
    doc: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'retained authored sentinel' }] }],
    },
  }),
);
const digest = createHash('sha256').update(retained).digest('hex');
const retainedHead = Buffer.from(retained.toString().replace('retained authored sentinel', 'retained head sentinel'));
const parseBytea = pg.types.getTypeParser(17, 'text');
let decodedBodies = 0;
let database: GrowthDatabase;
let access: ReturnType<typeof createAccess>;
let sign: (accountId: string, scopes: readonly string[]) => Promise<string>;
const deps = (selected: Access = access) => ({ pool: database.pool, access: selected, tokens });
const ctx = (actor: Actor = { kind: 'anonymous' }) => ({ actor, deadline: Date.now() + 10_000 });
const elapsedSeconds = (started: number) => Math.round(((performance.now() - started) / 1000) * 10_000) / 10_000;
const reportFixturePhases = (phases: Record<string, number>) =>
  process.stdout.write(`REZICS_KERNEL_FIXTURE_PHASES=${JSON.stringify(phases)}\n`);

beforeAll(async () => {
  const fixturePhases: Record<string, number> = {};
  let phaseStarted = performance.now();
  database = await openGrowthDatabase();
  fixturePhases.databaseFixture = elapsedSeconds(phaseStarted);
  phaseStarted = performance.now();
  const pair = await generateKeyPair('ES256');
  const publicKey = { ...(await exportJWK(pair.publicKey)), kid: 'read-test', alg: 'ES256' };
  const issuer = 'https://auth.example.test';
  const audience = 'https://api.rezics.test';
  access = createAccess({
    actions: new Map(actions.map((action) => [action, { anonymous: true }])),
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      async fetch() {
        return Response.json({ keys: [publicKey] });
      },
    },
  });
  sign = (accountId, scopes) =>
    new SignJWT({
      client_id: 'web',
      scope: scopes.join(' '),
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'read-test', typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(accountId)
      .setIssuedAt()
      .setExpirationTime('3m')
      .sign(pair.privateKey);
  fixturePhases.authSetup = elapsedSeconds(phaseStarted);
  phaseStarted = performance.now();
  for (const id of [author, reader])
    await database.admin.query(
      `INSERT INTO access.account (route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)`,
      [routeOf(id), id],
    );
  // Observe native decoding, without replacing queries, rows or Access decisions.
  pg.types.setTypeParser(17, 'text', (value) => {
    const bytes = parseBytea(value) as Buffer;
    if (bytes.equals(retained) || bytes.equals(retainedHead)) decodedBodies++;
    return bytes;
  });
  fixturePhases.accountFixture = elapsedSeconds(phaseStarted);
  reportFixturePhases(fixturePhases);
});
afterAll(async () => {
  pg.types.setTypeParser(17, 'text', parseBytea);
  await database?.close();
});

async function authenticate(accountId = reader, scopes: readonly string[] = actions) {
  return access.authenticate(await sign(accountId, scopes), { pool: database.pool, deadline: Date.now() + 180_000 });
}
async function fixture() {
  const board = newId(boardRoute),
    thread = newId(contentRoute),
    post = newId(contentRoute);
  const revision = newId(contentRoute);
  await database.admin.query(
    `INSERT INTO content.board
    (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,'Board','published',1,$2)`,
    [boardRoute, board, subject],
  );
  await database.admin.query('BEGIN');
  try {
    await database.admin.query(
      `INSERT INTO content.thread
      (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id)
      VALUES ($1,$2,$3,$4,'Retained authored title','published',1,$2,$5)`,
      [contentRoute, thread, author, board, post],
    );
    await insertPost(thread, post, revision, board);
    await database.admin.query('COMMIT');
  } catch (error) {
    await database.admin.query('ROLLBACK');
    throw error;
  }
  return { board, thread, post, revision };
}
async function insertRevision(thread: string, post: string, revision: string, board: string, body = retained) {
  await database.admin.query(
    `INSERT INTO content.revision
    (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,media_ids,board_id,availability,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,$5,sha256($5),'retained','CC-BY-4.0',$6,$7,$8,'available',$4)`,
    [contentRoute, thread, post, revision, body, [subject], [media], board],
  );
}
async function insertPost(
  thread: string,
  post: string,
  revision: string,
  board: string,
  parent: string | null = null,
  account = author,
) {
  await database.admin.query(
    `INSERT INTO content.post
    (route,thread_id,post_id,reply_to_post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,$5,$6,'published',1,$6)`,
    [contentRoute, thread, post, parent, account, revision],
  );
  await insertRevision(thread, post, revision, board);
}
async function grant(id: string, action: string) {
  await database.admin.query(
    `INSERT INTO access.resource_grant
    (route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,'(,)',$2)`,
    [routeOf(id), id, reader, action],
  );
}
async function state(kind: 'board' | 'thread' | 'post', id: string, visibility: string) {
  await database.admin.query(
    `UPDATE content.${kind} SET visibility=$3,security_revision=security_revision+1
    WHERE route=$1 AND ${kind}_id=$2`,
    [routeOf(id), id, visibility],
  );
}
async function erase(post: string) {
  // Privileged seed only: logical erasure deliberately precedes deferred physical NULLing.
  await database.admin.query(
    `UPDATE content.post SET availability='erased',security_revision=security_revision+1
    WHERE route=$1 AND post_id=$2`,
    [contentRoute, post],
  );
}

test('authorized current and exact erased reads preserve selected immutable identity without loading retained bytes', async () => {
  const f = await fixture();
  const head = newId(contentRoute);
  await insertRevision(f.thread, f.post, head, f.board, retainedHead);
  await database.admin.query('UPDATE content.post SET head_revision_id=$3 WHERE route=$1 AND post_id=$2', [
    contentRoute,
    f.post,
    head,
  ]);
  await erase(f.post);
  await grant(f.post, 'post:read');
  const actor = await authenticate();
  const before = decodedBodies;
  const exact = (await readPost(deps(), f.thread, f.post, ctx(actor), f.revision)).value;
  const current = (await readPost(deps(), f.thread, f.post, ctx(actor))).value;
  expect(exact).toMatchObject({
    id: f.post,
    revisionId: f.revision,
    sha256: null,
    licence: 'CC-BY-4.0',
    subjectIds: [subject],
    mediaIds: [media],
    boardId: f.board,
    body: null,
    availability: 'erased',
  });
  expect(current).toEqual<Omit<NonNullable<typeof exact>, 'sha256'> & { revisionId: string; sha256: null }>({
    ...exact!,
    revisionId: head,
    sha256: null,
  });
  expect(decodedBodies).toBe(before);
  const stored = await database.admin.query(
    'SELECT body,availability FROM content.revision WHERE route=$1 AND revision_id=$2',
    [contentRoute, f.revision],
  );
  expect(stored.rows[0]).toEqual({ body: retained, availability: 'available' });
});

test('erasure and taken-down chain facts require authenticated grants and scopes on every protected resource', async () => {
  const f = await fixture();
  const child = newId(contentRoute),
    revision = newId(contentRoute);
  await database.admin.query('BEGIN');
  await insertPost(f.thread, child, revision, f.board, f.post);
  await database.admin.query('COMMIT');
  await erase(child);
  const actor = await authenticate();
  const authorActor = await authenticate(author);
  const noScope = await authenticate(reader, ['board:read', 'thread:read']);
  const read = (selected: Actor, exact = false) =>
    readPost(deps(), f.thread, child, ctx(selected), exact ? revision : undefined);
  const placeholder = {
    id: child,
    threadId: f.thread,
    route: contentRoute,
    parentId: f.post,
    removed: true,
    availability: 'erased',
    body: null,
    sha256: null,
  } as const;
  for (const selected of [{ kind: 'anonymous' } as const, actor, authorActor])
    expect((await read(selected)).value).toEqual(placeholder);
  await grant(child, 'post:read');
  for (const exact of [false, true]) {
    expect((await read(actor, exact)).value?.body).toBeNull();
    expect((await read(actor, exact)).value?.availability).toBe('erased');
    expect((await read(noScope, exact)).value).toBeNull();
    if (exact) {
      expect((await read({ kind: 'anonymous' }, exact)).value).toBeNull();
      expect((await read(authorActor, exact)).value).toBeNull();
    } else {
      expect((await read({ kind: 'anonymous' }, exact)).value).toEqual(placeholder);
      expect((await read(authorActor, exact)).value).toEqual(placeholder);
    }
  }
  await state('thread', f.thread, 'taken_down');
  await state('post', f.post, 'taken_down');
  expect((await read(actor)).value).toBeNull();
  await grant(f.thread, 'thread:read');
  expect((await read(actor)).value).toBeNull();
  await grant(f.post, 'post:read');
  expect((await read(actor)).value?.id).toBe(child);
  expect((await read(await authenticate(reader, ['post:read']))).value).toBeNull();
  await state('board', f.board, 'protected');
  expect((await read(actor)).value).toBeNull();
  await grant(f.board, 'board:read');
  expect((await read(actor)).value?.id).toBe(child);
  await database.admin.query(
    `INSERT INTO access.resource_denial
    (route,resource_id,subject_id,action,reason,valid,transaction_id)
    VALUES ($1,$2,$3,'post:read','resource','(,)',$2)`,
    [contentRoute, child, reader],
  );
  expect((await read(actor)).value).toBeNull();
  expect((await readPost(deps(), f.thread, newId(contentRoute), ctx(actor))).value).toBeNull();
});

test('erased first-post thread suppresses retained title while unrelated ordinary and taken-down reads keep their policy', async () => {
  const f = await fixture();
  const other = newId(contentRoute),
    revision = newId(contentRoute);
  await database.admin.query('BEGIN');
  await insertPost(f.thread, other, revision, f.board, null, reader);
  await database.admin.query('COMMIT');
  const ordinary = (await readPost(deps(), f.thread, other, ctx())).value;
  await erase(f.post);
  await grant(f.post, 'post:read');
  const actor = await authenticate();
  const before = decodedBodies;
  const result = (await readThread(deps(), f.thread, ctx(actor))).value;
  expect(result).toMatchObject({ id: f.thread, title: null, firstPost: { body: null, availability: 'erased' } });
  expect(decodedBodies).toBe(before);
  const anonymous = (await readThread(deps(), f.thread, ctx())).value;
  expect(anonymous).toMatchObject({ id: f.thread, title: null });
  expect(anonymous?.firstPost).toEqual({
    id: f.post,
    threadId: f.thread,
    route: contentRoute,
    parentId: null,
    removed: true,
    availability: 'erased',
    body: null,
    sha256: null,
  });
  expect((await readPost(deps(), f.thread, other, ctx())).value).toEqual(ordinary);
  expect((await readBoard(deps(), f.board, ctx())).value?.title).toBe('Board');
  await state('post', other, 'taken_down');
  await grant(other, 'post:read');
  for (const exact of [undefined, revision])
    expect((await readPost(deps(), f.thread, other, ctx(actor), exact)).value).toBeNull();
  expect(
    (
      await database.admin.query('SELECT title FROM content.thread WHERE route=$1 AND thread_id=$2', [
        contentRoute,
        f.thread,
      ])
    ).rows[0].title,
  ).toBe('Retained authored title');
});

test('final native checks reject changed chain signatures and independently anchored board security revisions', async () => {
  for (const change of ['chain', 'board', 'denial'] as const) {
    const f = await fixture();
    await erase(f.post);
    await grant(f.post, 'post:read');
    const actor = await authenticate();
    let changed = false;
    const observed: Access = {
      ...access,
      async prepare(...args) {
        const evidence = await access.prepare!(...args);
        if (!changed && args[1] === (change === 'board' ? 'board:read' : 'post:read')) {
          changed = true;
          if (change === 'board') await state('board', f.board, 'protected');
          else if (change === 'chain') await state('post', f.post, 'protected');
          else
            await database.admin.query(
              `INSERT INTO access.resource_denial
          (route,resource_id,subject_id,action,reason,valid,transaction_id)
          VALUES ($1,$2,$3,'post:read','resource','(,)',$2)`,
              [contentRoute, f.post, reader],
            );
        }
        return evidence;
      },
    };
    expect((await readPost(deps(observed), f.thread, f.post, ctx(actor))).value).toBeNull();
    expect(changed).toBe(true);
  }
});

test('checkGrowth keeps the actual authenticated erased read bounded at three informative scales', async () => {
  const f = await fixture();
  await erase(f.post);
  await grant(f.post, 'post:read');
  const actor = await authenticate();
  const evidenceDirectory = new URL('../../../../.temp/current-erased-read/', import.meta.url);
  mkdirSync(evidenceDirectory, { recursive: true });
  const read = async () => {
    const before = decodedBodies;
    const result = await readPost(deps(), f.thread, f.post, ctx(actor));
    expect(result.value).toMatchObject({ revisionId: f.revision, sha256: null, body: null, availability: 'erased' });
    expect(decodedBodies).toBe(before);
  };
  const report = await checkGrowth(database, {
    name: 'current erased native disclosure',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(db, scale, previous) {
      // Two rows per scale unit put every probed storage relation above 500 at the first scale.
      await seed(
        db,
        {
          name: 'current-erased-read',
          hotPartition: partitionOf(contentRoute),
          hotShare: 1,
          rows() {
            const board = newId(boardRoute),
              thread = newId(contentRoute),
              post = newId(contentRoute);
            const revision = newId(contentRoute),
              account = newId(routeOf(reader)!);
            const common = { route: contentRoute, thread_id: thread, recorded_transaction_id: revision };
            return {
              'content.board': [
                {
                  route: boardRoute,
                  board_id: board,
                  subject_id: subject,
                  title: 'Neighbour',
                  visibility: 'published',
                  security_revision: 1,
                  recorded_transaction_id: board,
                },
              ],
              'content.thread': [
                {
                  ...common,
                  author_account_id: account,
                  board_id: board,
                  title: 'Neighbour',
                  visibility: 'published',
                  security_revision: 1,
                },
              ],
              'content.post': [
                {
                  ...common,
                  post_id: post,
                  author_account_id: account,
                  head_revision_id: revision,
                  visibility: 'published',
                  security_revision: 1,
                },
              ],
              'content.revision': [
                {
                  ...common,
                  post_id: post,
                  revision_id: revision,
                  body: retained,
                  body_sha256: Buffer.from(digest, 'hex'),
                  search_text: 'retained',
                  licence: 'CC-BY-4.0',
                  subject_ids: [subject],
                  board_id: board,
                  availability: 'available',
                },
                {
                  ...common,
                  thread_id: f.thread,
                  post_id: f.post,
                  revision_id: newId(contentRoute),
                  body: retained,
                  body_sha256: Buffer.from(digest, 'hex'),
                  search_text: 'retained',
                  licence: 'CC-BY-4.0',
                  subject_ids: [subject],
                  board_id: f.board,
                  availability: 'available',
                },
              ],
              'access.account': [
                {
                  route: routeOf(account),
                  account_id: account,
                  kind: 'actor',
                  state: 'active',
                  transaction_id: account,
                },
              ],
              'access.membership_inverse': [
                {
                  route: routeOf(account),
                  account_id: account,
                  kind: 'organization',
                  group_id: newId(boardRoute),
                  reservation_id: account,
                  transaction_id: account,
                },
              ],
              'access.resource_grant': [
                {
                  route: contentRoute,
                  resource_id: post,
                  subject_id: account,
                  action: 'post:read',
                  valid: '(,)',
                  transaction_id: post,
                },
              ],
              'access.resource_role_grant': [
                {
                  route: contentRoute,
                  resource_id: post,
                  subject_id: account,
                  grant_role: 'unused',
                  valid: '(,)',
                  transaction_id: post,
                },
              ],
              'access.resource_denial': [
                {
                  route: contentRoute,
                  resource_id: post,
                  subject_id: account,
                  action: 'post:read',
                  reason: 'resource',
                  valid: '(,)',
                  transaction_id: post,
                },
              ],
            };
          },
        },
        { from: previous * 2, to: scale * 2 },
      );
      const evidence = await capture(db, read);
      await Bun.write(new URL(`${scale}.json`, evidenceDirectory), JSON.stringify(evidence.capture));
    },
    operation: read,
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const sample of report.samples) {
    for (const relation of ['content.board', 'content.thread', 'content.post', 'content.revision']) {
      expect(sample.cost.relations?.[relation]?.rows).toBeGreaterThan(0);
      expect(sample.cost.relations?.[relation]?.sequentialScans).toBe(0);
    }
  }
  await Bun.write(new URL('report.json', evidenceDirectory), JSON.stringify(report));
}, 180_000);
