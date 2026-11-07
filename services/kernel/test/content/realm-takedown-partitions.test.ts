import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GrantDeniedError } from '../../src/access/contract/index.ts';
import { erasePost, takedown } from '../../src/content/moderation.ts';
import boardRealm from '../../src/content/realm-of-board.sql';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

const boardRoute = 0x4321;
const targetRoute = 0x1234;
const realmId = newId(boardRoute);
const otherRealmId = newId(boardRoute);
let f: Awaited<ReturnType<typeof standingFixture>>;
let moderator: Awaited<ReturnType<typeof f.context>>['actor'];
let otherModerator: typeof moderator;
const context = () => ({
  idempotencyKey: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
  deadline: Date.now() + 10000,
});
const deps = () => ({ clock: () => new Date(), pool: f.pool, access: f.access, routeKey: new Uint8Array(32).fill(7) });

beforeAll(async () => {
  f = await standingFixture(['realm:read', 'realm:ban', 'realm:publish', 'board:create']);
  moderator = (await f.context()).actor;
  otherModerator = (await f.context(f.principal)).actor;
  const client = await f.reader.connect();
  try {
    await client.query('BEGIN');
    for (const id of [realmId, otherRealmId]) {
      const space = newId(boardRoute);
      const spaceRevision = newId(boardRoute);
      const revision = newId(boardRoute);
      const contextId = newId(boardRoute);
      await client.query(
        `INSERT INTO community.space(route,space_id,state,head_revision_id,created_at,creator)
         VALUES ($1,$2,'active',$3,now(),$4)`,
        [boardRoute, space, spaceRevision, moderator.accountId],
      );
      await client.query(
        `INSERT INTO community.space_revision(route,space_id,revision_id,title,summary,created_at,author)
         VALUES ($1,$2,$3,'Space','',now(),$4)`,
        [boardRoute, space, spaceRevision, moderator.accountId],
      );
      await client.query(
        `INSERT INTO community.realm
         (route,realm_id,space_id,state,visibility,context_id,head_revision_id,created_at,creator)
         VALUES ($1,$2,$3,'active','public',$4,$5,now(),$6)`,
        [boardRoute, id, space, contextId, revision, moderator.accountId],
      );
      await client.query(
        `INSERT INTO community.realm_revision
         (route,realm_id,revision_id,title,summary,visibility,context_id,created_at,author)
         VALUES ($1,$2,$3,'Realm','','public',$4,now(),$5)`,
        [boardRoute, id, revision, contextId, moderator.accountId],
      );
    }
    for (const [id, account] of [
      [realmId, moderator.accountId],
      [otherRealmId, otherModerator.accountId],
    ]) {
      await client.query(
        `INSERT INTO access.resource_role_grant
         (route,resource_id,subject_id,grant_role,valid,transaction_id)
         VALUES ($1,$2,$3,'community.realm.moderator','(,)',$2)`,
        [boardRoute, id, account],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});
afterAll(() => f?.close());

async function target(kind: 'thread' | 'post', realm: string | null = realmId) {
  const boardId = newId(boardRoute);
  const threadId = newId(targetRoute);
  const postId = newId(targetRoute);
  await f.reader.query(
    `INSERT INTO content.board(route,board_id,realm_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,'Board','published',1,$2)`,
    [boardRoute, boardId, realm, newId(boardRoute)],
  );
  await f.reader.query(
    `INSERT INTO content.thread(route,thread_id,board_id,author_account_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,'Thread','published',1,$2)`,
    [targetRoute, threadId, boardId, f.recipient],
  );
  if (kind === 'post') {
    await f.reader.query(
      `WITH post AS (
         INSERT INTO content.post(route,post_id,thread_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
         VALUES ($1,$2,$3,$4,$5,'published',1,$2)
         RETURNING route,post_id,thread_id,head_revision_id
       )
       INSERT INTO content.revision(route,post_id,thread_id,revision_id,board_id,availability,licence,subject_ids,recorded_transaction_id)
       SELECT route,post_id,thread_id,head_revision_id,$6,'erased','MIT','{}',post_id FROM post`,
      [targetRoute, postId, threadId, f.recipient, newId(targetRoute), boardId],
    );
  }
  return { boardId, kind, id: kind === 'thread' ? threadId : postId };
}

async function stored(value: { kind: 'thread' | 'post'; id: string }) {
  return (
    await f.reader.query(
      `SELECT visibility,security_revision::text FROM content.${value.kind} WHERE route=$1 AND ${value.kind}_id=$2`,
      [routeOf(value.id), value.id],
    )
  ).rows[0];
}

for (const kind of ['thread', 'post'] as const) {
  test(`Realm moderator takes down a ${kind} across partitions using the board's own route`, async () => {
    const value = await target(kind);
    expect(partitionOf(boardRoute)).not.toBe(partitionOf(targetRoute));
    const observer = observeSql(f.pool);
    try {
      const result = await takedown(deps(), moderator, { target: value, reason: 'Realm moderation' }, context());
      expect(result.partition).toBe(partitionOf(targetRoute));
      expect(await stored(value)).toEqual({ visibility: 'taken_down', security_revision: '2' });
      const reads = observer.records.filter(({ statement }) => statement === boardRealm.sql);
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) {
        const parameters = { route: boardRoute, id: value.boardId };
        expect(read.parameters).toEqual(boardRealm.params.map((name) => parameters[name as keyof typeof parameters]));
      }
    } finally {
      await observer.close();
    }
  });

  test(`another Realm's moderator and a ${kind} in a board without a Realm are refused`, async () => {
    for (const [realm, actor] of [
      [realmId, otherModerator],
      [null, moderator],
    ] as const) {
      const value = await target(kind, realm);
      await expect(
        takedown(deps(), actor, { target: value, reason: 'Outside Realm' }, context()),
      ).rejects.toBeInstanceOf(GrantDeniedError);
      expect(await stored(value)).toEqual({ visibility: 'published', security_revision: '1' });
    }
  });
}

test('author erasure never resolves the board Realm', async () => {
  const value = await target('post');
  const author = (await f.context(f.recipient)).actor;
  await f.grant(author.accountId, 'post:erase', { route: targetRoute, id: value.id });
  const observer = observeSql(f.pool);
  try {
    await erasePost(deps(), author, { postId: value.id, reason: 'Author erasure' }, context());
    expect(observer.records.filter(({ statement }) => statement === boardRealm.sql)).toEqual([]);
  } finally {
    await observer.close();
  }
});
