import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createResourcePublicEligibility, createAccess } from '../../src/access/index.ts';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { withConnection } from '../../src/database/pool.ts';
import { readPartition } from '../../src/partition/partition.ts';
import { accessCheck, type Resource } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { isErasedPlaceholder } from '../../src/content/model.ts';
import {
  readBoard,
  readThread,
  readPost,
  listThreadPosts,
  listPostRevisions,
  discloseThreads,
} from '../../src/content/reads.ts';
import { createAccess as permissionAccess } from '../../src/access/permission.ts';
import { readAccount, type Account } from '../../src/access/account-data.ts';
import type { Actor } from '../../src/request/access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const route = 0x9abc;
const board: Resource = { route, id: newId(route) };
const subject = newId(0xdef0);
const action = 'board:read';
const actor = { kind: 'anonymous' } as const;
const access = createAccess({ actions: new Map([[action, { anonymous: true }]]) });
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
let database: GrowthDatabase;

beforeAll(async () => {
  database = await openGrowthDatabase(databaseUrl);
  await database.admin.query(
    `INSERT INTO content.board
     (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
     VALUES ($1, $2, $3, 'Public board', 'published', 1, $2)`,
    [route, board.id, subject],
  );
});
afterAll(async () => {
  if (!database) return;
  await database.admin.query('DELETE FROM content.board WHERE route = $1', [route]);
  await database.close();
});

function context() {
  return { pool: database.pool, deadline: Date.now() + 5_000 };
}

const contentRoute = 0x1234;
const accounts = new Map<string, Account>();
const nativeAccess = permissionAccess({
  actions: new Map(['board:read', 'thread:read', 'post:read'].map((name) => [name, { anonymous: true }])),
  accountEvidence: (viewer) => accounts.get(viewer.accountId),
});
function viewer(accountId: string, scopes = ['board:read', 'thread:read', 'post:read']): Actor {
  return { kind: 'account', accountId, scopes, clientId: 'web', requestedBy: null, authnEpoch: 1 };
}
const deps = () => ({ pool: database.pool, access: nativeAccess, tokens });
const ctx = (selected: Actor = actor) => ({ actor: selected, deadline: Date.now() + 5_000 });

async function account() {
  const accountId = newId(0x5678);
  await database.admin.query(
    `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
     VALUES ($1,$2,'actor','active',$2)`,
    [routeOf(accountId), accountId],
  );
  accounts.set(accountId, (await readAccount(database.admin, routeOf(accountId)!, accountId))!);
  return accountId;
}

async function fixture() {
  const [author, unrelated] = await Promise.all([account(), account()]);
  const thread = newId(contentRoute);
  const post = newId(contentRoute);
  const revision = newId(contentRoute);
  await database.admin.query('BEGIN');
  try {
    await database.admin.query(
      `INSERT INTO content.thread
       (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id)
       VALUES ($1,$2,$3,$4,'Thread sentinel','published',1,$2,$5)`,
      [contentRoute, thread, author, board.id, post],
    );
    await insertPost(thread, post, revision, null, author);
    await database.admin.query('COMMIT');
  } catch (error) {
    await database.admin.query('ROLLBACK');
    throw error;
  }
  return { thread, post, revision, author, unrelated };
}
async function insertRevision(thread: string, post: string, revision: string, text = 'original', refs = [subject]) {
  const body = Buffer.from(serializeDocument(fromPlainText(text)));
  await database.admin.query(
    `INSERT INTO content.revision
     (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,$5,sha256($5),$6,'CC-BY-4.0',$7,$8,'available',$4)`,
    [contentRoute, thread, post, revision, body, text, refs, board.id],
  );
}
async function insertPost(thread: string, post: string, revision: string, parent: string | null, author: string) {
  await database.admin.query(
    `INSERT INTO content.post
     (route,thread_id,post_id,reply_to_post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,$5,$6,'published',1,$6)`,
    [contentRoute, thread, post, parent, author, revision],
  );
  await insertRevision(thread, post, revision);
}
async function reply(thread: string, parent: string, author: string) {
  const post = newId(contentRoute);
  const revision = newId(contentRoute);
  await database.admin.query('BEGIN');
  try {
    await insertPost(thread, post, revision, parent, author);
    await database.admin.query('COMMIT');
  } catch (error) {
    await database.admin.query('ROLLBACK');
    throw error;
  }
  return { post, revision };
}
async function visibility(table: 'thread' | 'post' | 'board', id: string, state: string) {
  await database.admin.query(
    `UPDATE content.${table} SET visibility=$3,security_revision=security_revision+1 WHERE route=$1 AND ${table}_id=$2`,
    [routeOf(id), id, state],
  );
}
async function grant(id: string, action: string, accountId: string) {
  await database.admin.query(
    `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,$4,'(,)',$2)`,
    [routeOf(id), id, accountId, action],
  );
}

test('native floor admits anonymous and zero-scope accounts; explicit denial still wins', async () => {
  const f = await fixture();
  for (const selected of [actor, viewer(f.unrelated, [])]) {
    expect((await readThread(deps(), f.thread, ctx(selected))).value?.firstPost.id).toBe(f.post);
    const post = (await readPost(deps(), f.thread, f.post, ctx(selected))).value;
    expect(post && !isErasedPlaceholder(post) ? post.revisionId : null).toBe(f.revision);
    expect((await listThreadPosts(deps(), f.thread, ctx(selected))).entries.map(({ id }) => id)).toContain(f.post);
  }
  await database.admin.query(
    `INSERT INTO access.resource_denial (route,resource_id,subject_id,action,reason,valid,transaction_id)
     VALUES ($1,$2,$3,'post:read','resource','(,)',$2)`,
    [contentRoute, f.post, f.unrelated],
  );
  expect((await readPost(deps(), f.thread, f.post, ctx(viewer(f.unrelated, [])))).value).toBeNull();
  expect((await readPost(deps(), f.thread, f.post, ctx())).value?.id).toBe(f.post);
});

test('draft detail and history require the author AND explicit authority; protected authorship supplies no grant', async () => {
  const f = await fixture();
  await visibility('thread', f.thread, 'draft');
  await visibility('post', f.post, 'draft');
  // Direct storage fixtures intentionally assign no creator grants. This keeps
  // identity/authorship intact while independently testing the grant operand.
  expect((await readPost(deps(), f.thread, f.post, ctx(viewer(f.author)))).value).toBeNull();
  await grant(f.thread, 'thread:read', f.author);
  await grant(f.post, 'post:read', f.author);
  expect((await readThread(deps(), f.thread, ctx(viewer(f.author)))).value?.id).toBe(f.thread);
  for (const selected of [actor, viewer(f.unrelated)]) {
    expect((await readThread(deps(), f.thread, ctx(selected))).value).toBeNull();
    expect((await readPost(deps(), f.thread, f.post, ctx(selected), f.revision)).value).toBeNull();
    await expect(listThreadPosts(deps(), f.thread, ctx(selected))).rejects.toMatchObject({
      name: 'ContentNotFoundError',
    });
    await expect(listPostRevisions(deps(), f.thread, f.post, ctx(selected))).rejects.toMatchObject({
      name: 'ContentNotFoundError',
    });
  }
  await grant(f.thread, 'thread:read', f.unrelated);
  await grant(f.post, 'post:read', f.unrelated);
  expect((await readPost(deps(), f.thread, f.post, ctx(viewer(f.unrelated)))).value).toBeNull();
  await visibility('thread', f.thread, 'protected');
  await visibility('post', f.post, 'protected');
  await database.admin.query(
    'DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=ANY($2::uuid[]) AND subject_id=$3',
    [contentRoute, [f.thread, f.post], f.author],
  );
  expect((await readPost(deps(), f.thread, f.post, ctx(viewer(f.author)))).value).toBeNull();
  await grant(f.thread, 'thread:read', f.author);
  await grant(f.post, 'post:read', f.author);
  expect((await readPost(deps(), f.thread, f.post, ctx(viewer(f.author)))).value?.id).toBe(f.post);
});

test('every reply ancestor and independently anchored board is checked at final disclosure', async () => {
  const f = await fixture();
  const parent = await reply(f.thread, f.post, f.author);
  const child = await reply(f.thread, parent.post, f.author);
  expect((await readPost(deps(), f.thread, child.post, ctx())).value?.id).toBe(child.post);
  await visibility('post', parent.post, 'protected');
  expect((await readPost(deps(), f.thread, child.post, ctx(), child.revision)).value).toBeNull();
  expect((await readThread(deps(), f.thread, ctx())).value?.firstPost.id).toBe(f.post);
  expect((await listThreadPosts(deps(), f.thread, ctx())).entries.map(({ id }) => id)).toEqual([f.post]);
  await visibility('board', board.id, 'protected');
  try {
    expect((await readThread(deps(), f.thread, ctx())).value).toBeNull();
    expect((await discloseThreads(deps(), [f.thread], ctx()))[0]?.value).toBeNull();
    await grant(board.id, 'board:read', f.author);
    expect((await readThread(deps(), f.thread, ctx(viewer(f.author)))).value?.id).toBe(f.thread);
  } finally {
    await visibility('board', board.id, 'published');
  }
});

test('exact revision retains its own bytes and references; takedown never discloses ordinary history', async () => {
  const f = await fixture();
  const edited = newId(contentRoute);
  await insertRevision(f.thread, f.post, edited, 'edited', []);
  await database.admin.query('UPDATE content.post SET head_revision_id=$3 WHERE route=$1 AND post_id=$2', [
    contentRoute,
    f.post,
    edited,
  ]);
  const old = (await readPost(deps(), f.thread, f.post, ctx(), f.revision)).value!;
  const current = (await readPost(deps(), f.thread, f.post, ctx())).value!;
  if (isErasedPlaceholder(old) || isErasedPlaceholder(current)) throw new Error('Available post became a placeholder');
  expect(old.revisionId).toBe(f.revision);
  expect(old.subjectIds).toEqual([subject]);
  expect(old.boardId).toBe(board.id);
  expect(old.licence).toBe('CC-BY-4.0');
  expect(current.subjectIds).toEqual([]);
  expect(current.body).not.toEqual(old.body);
  expect((await listPostRevisions(deps(), f.thread, f.post, ctx())).entries.map(({ id }) => id)).toContain(f.revision);
  await visibility('post', f.post, 'taken_down');
  await grant(f.post, 'post:read', f.author);
  expect((await readPost(deps(), f.thread, f.post, ctx(viewer(f.author)), f.revision)).value).toBeNull();
  await database.admin.query(
    "UPDATE content.post SET availability='erased',security_revision=security_revision+1 WHERE route=$1 AND post_id=$2",
    [contentRoute, f.post],
  );
  const tombstone = (await readPost(deps(), f.thread, f.post, ctx(viewer(f.author)), f.revision)).value!;
  expect(tombstone).toMatchObject({ revisionId: f.revision, sha256: null, availability: 'erased', body: null });
  expect((await readPost(deps(), f.thread, f.post, ctx(), f.revision)).value).toBeNull();
});

test('unknown, concealed and missing container evidence have identical absence', async () => {
  const f = await fixture();
  const missing = newId(contentRoute);
  await visibility('thread', f.thread, 'protected');
  expect((await readThread(deps(), f.thread, ctx())).value).toEqual((await readThread(deps(), missing, ctx())).value);
  await expect(listThreadPosts(deps(), f.thread, ctx())).rejects.toMatchObject({ name: 'ContentNotFoundError' });
  await expect(listThreadPosts(deps(), missing, ctx())).rejects.toMatchObject({ name: 'ContentNotFoundError' });
  await visibility('thread', f.thread, 'published');
  await database.admin.query('ALTER TABLE content.board RENAME TO unavailable_board');
  try {
    await expect(readThread(deps(), f.thread, ctx())).rejects.toBeInstanceOf(Error);
  } finally {
    await database.admin.query('ALTER TABLE content.unavailable_board RENAME TO board');
  }
});

test('reply depth overflow fails closed and candidate/page inputs remain bounded', async () => {
  const f = await fixture();
  let parent = f.post;
  for (let depth = 0; depth < 33; depth++) parent = (await reply(f.thread, parent, f.author)).post;
  expect((await readPost(deps(), f.thread, parent, ctx())).value).toBeNull();
  await expect(
    discloseThreads(
      deps(),
      Array.from({ length: 201 }, () => f.thread),
      ctx(),
    ),
  ).rejects.toBeInstanceOf(RangeError);
  await expect(listThreadPosts(deps(), f.thread, ctx(), undefined, 101)).rejects.toBeInstanceOf(RangeError);
  const page = await listThreadPosts(deps(), f.thread, ctx(), undefined, 1);
  expect(page.entries).toHaveLength(1);
  expect(page.nextCursor).toBeString();
  await expect(listThreadPosts(deps(), newId(contentRoute), ctx(), page.nextCursor!, 1)).rejects.toBeInstanceOf(Error);
});

// This consumes the Accounts capability directly before any content adapter is
// implemented. Catalogue metadata alone is deliberately insufficient evidence.
test('shared Access consumes anchored current public eligibility without a grant or scope', async () => {
  const calls: string[] = [];
  const resource = {
    ...board,
    eligibility: createResourcePublicEligibility({
      resource: board,
      action,
      async prepare({ pool, resource }) {
        calls.push('prepare');
        return withConnection(pool, async (client) => {
          const anchor = await readPartition(client, partitionOf(resource.route));
          const result = await client.query<{ security_revision: string; visibility: string }>(
            'SELECT security_revision, visibility FROM content.board WHERE route = $1 AND board_id = $2',
            [resource.route, resource.id],
          );
          return { anchor, row: result.rows[0] };
        });
      },
      async verify({ client, resource, evidence, at }) {
        calls.push('verify');
        expect(Number.isFinite(Date.parse(at))).toBe(true);
        if (!evidence.anchor || evidence.row?.visibility !== 'published') return false;
        const result = await client.query<{ security_revision: string; visibility: string }>(
          'SELECT security_revision, visibility FROM content.board WHERE route = $1 AND board_id = $2',
          [resource.route, resource.id],
        );
        return (
          result.rows[0]?.visibility === 'published' &&
          result.rows[0]?.security_revision === evidence.row.security_revision
        );
      },
    }),
  };
  const check = await accessCheck(access, actor, action, resource, context());
  const allowed = await withConnection(database.pool, (client) => check(client));
  expect(allowed).toBe(true);
  expect(calls).toEqual(['prepare', 'verify']);
});

test('missing trusted eligibility fails closed despite an anonymous action catalogue', async () => {
  const resource = {
    ...board,
    eligibility: createResourcePublicEligibility({
      resource: board,
      action,
      async prepare() {
        return null;
      },
      async verify() {
        return false;
      },
    }),
  };
  const check = await accessCheck(access, actor, action, resource, context());
  expect(await withConnection(database.pool, (client) => check(client))).toBe(false);
});

test('readBoard returns current public metadata with an authoritative partition head', async () => {
  const freshBoardId = newId(route);
  await database.admin.query(
    `INSERT INTO content.board
     (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
     VALUES ($1, $2, $3, 'Public board', 'published', 1, $2)`,
    [route, freshBoardId, subject],
  );
  const result = await readBoard({ pool: database.pool, access, tokens }, freshBoardId, { actor, ...context() });
  expect(result.value).toMatchObject({ id: freshBoardId, route, title: 'Public board', securityRevision: '1' });
  const partition = await readPartition(database.admin, partitionOf(route));
  expect(partition).not.toBeNull();
  expect(result.anchor).toEqual({ partition: partition!, epoch: partition!.epoch, position: partition!.position });
});

test('checkGrowth bounds real board disclosure as unrelated data in the same partition grows', async () => {
  const f = await fixture();
  // The measured neighbourhood combines four public reads: fixed board/post
  // disclosure plus one post and one revision candidate. Their fixed hydration
  // caps give constant rows and a sum of logarithmic history probes, plus Access.
  const populate = async (scale: number, previous: number) => {
    for (let ordinal = previous; ordinal < scale; ordinal++) {
      const id = newId(route);
      await database.admin.query(
        `INSERT INTO content.board
         (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
         VALUES ($1, $2, $3, 'Distractor', 'published', 1, $2)`,
        [route, id, subject],
      );
      await reply(f.thread, f.post, f.author);
      await insertRevision(f.thread, f.post, newId(contentRoute), 'History distractor');
    }
    await database.admin.query('ANALYZE content.board');
    await database.admin.query('ANALYZE content.post');
    await database.admin.query('ANALYZE content.revision');
  };
  await populate(2048, 0);
  const report = await checkGrowth(database, {
    name: 'current board, post, post-page and revision-page disclosure',
    rule: 'series',
    scales: [32, 256, 2048],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow: (_db, scale, previous) => populate(scale, previous),
    async operation(db) {
      const result = await readBoard({ pool: db.pool, access, tokens }, board.id, { actor, ...context() });
      expect(result.value?.id).toBe(board.id);
      const dependencies = { pool: db.pool, access: nativeAccess, tokens };
      expect((await readPost(dependencies, f.thread, f.post, ctx())).value?.id).toBe(f.post);
      expect((await listThreadPosts(dependencies, f.thread, ctx(), undefined, 1)).entries[0]?.id).toBe(f.post);
      expect((await listPostRevisions(dependencies, f.thread, f.post, ctx(), undefined, 1)).entries[0]?.id).toBe(
        f.revision,
      );
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([32, 256, 2048]);
  console.info(JSON.stringify(report));
}, 60_000);
