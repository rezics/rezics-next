import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { createReplyNoticeEffect } from '../../src/content/reply-notices.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';

let f: Awaited<ReturnType<typeof replyNoticeFixture>>;
beforeAll(async () => {
  f = await replyNoticeFixture();
});
afterAll(async () => {
  await f?.close();
});

test('the registered worker Access sends public replies without recipient credentials', async () => {
  const thread = await f.thread();
  const post = await f.post(thread.id);
  const access = createContentWorkAccess(() => new Date(), f.db.pool);
  await createReplyNoticeEffect(f.db.pool, access).run((await f.envelope(post.id)).events.find(Boolean)!);
  expect((await f.notices(post.id)).map((row) => row.recipient_id)).toEqual([f.accounts.recipient]);
});

test('the real standing port observes a containing Realm read revocation at send time', async () => {
  const route = routeOf(f.boardId)!;
  const board = newId(route);
  const space = newId(route),
    realm = newId(route),
    spaceRevision = newId(route),
    realmRevision = newId(route);
  const client = await f.db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO community.space(route,space_id,state,head_revision_id,created_at,creator)
      VALUES ($1,$2,'active',$3,clock_timestamp(),$4)`,
      [route, space, spaceRevision, f.accounts.recipient],
    );
    await client.query(
      `INSERT INTO community.space_revision(route,space_id,revision_id,title,summary,created_at,author)
      VALUES ($1,$2,$3,'Reply space','',clock_timestamp(),$4)`,
      [route, space, spaceRevision, f.accounts.recipient],
    );
    await client.query(
      `INSERT INTO community.realm(route,realm_id,space_id,state,visibility,context_id,head_revision_id,created_at,creator)
      VALUES ($1,$2,$3,'active','public',$4,$5,clock_timestamp(),$6)`,
      [route, realm, space, newId(route), realmRevision, f.accounts.recipient],
    );
    await client.query(
      `INSERT INTO community.realm_revision(route,realm_id,revision_id,title,summary,visibility,context_id,created_at,author)
      SELECT route,realm_id,head_revision_id,'Reply Realm','','public',context_id,clock_timestamp(),creator
      FROM community.realm WHERE route=$1 AND realm_id=$2`,
      [route, realm],
    );
    await client.query(
      `INSERT INTO content.board(route,board_id,subject_id,title,realm_id,visibility,security_revision,recorded_transaction_id)
      VALUES ($1,$2,$3,'Realm reply board',$4,'published',1,$5)`,
      [route, board, newId(route), realm, crypto.randomUUID()],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  try {
    for (const account of [f.accounts.actor, f.accounts.principal, f.accounts.recipient]) {
      await f.accounts.grant(account, 'realm:read', { route, id: realm });
      await f.accounts.grant(account, 'realm:participate', { route, id: realm });
      await f.accounts.grant(account, 'board:read', { route, id: board });
      await f.accounts.grant(account, 'thread:create', { route, id: board });
    }
    const thread = await f.thread(f.accounts.recipient, 'published', board);
    const control = await f.post(thread.id);
    await createReplyNoticeEffect(f.db.pool, f.accounts.access).run(
      (await f.envelope(control.id)).events.find(Boolean)!,
    );
    expect(await f.notices(control.id)).toHaveLength(1);
    const post = await f.post(thread.id);
    expect((await f.call(f.accounts.recipient, 'GET', `/v1/posts/${post.id}`)).status).toBe(200);
    await f.db.admin.query(
      `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
      VALUES ($1,$2,$3,'realm:read','resource','(,)',$3)`,
      [route, realm, f.accounts.recipient],
    );
    expect((await f.call(f.accounts.recipient, 'GET', `/v1/posts/${post.id}`)).status).toBe(404);
    await createReplyNoticeEffect(f.db.pool, f.accounts.access).run((await f.envelope(post.id)).events.find(Boolean)!);
    expect(await f.notices(post.id)).toEqual([]);
  } finally {
    await f.db.admin.query('DELETE FROM access.resource_denial WHERE resource_id=$1 AND subject_id=$2', [
      realm,
      f.accounts.recipient,
    ]);
  }
});

test('domain read denial completes without retrying or writing a reply notice', async () => {
  const thread = await f.thread();
  const parent = await f.post(thread.id, f.accounts.recipient);
  const post = await f.post(thread.id, f.accounts.actor, parent.id);
  await f.db.admin.query(
    "UPDATE content.post SET visibility='taken_down',security_revision=security_revision+1 WHERE route=$1 AND post_id=$2",
    [routeOf(parent.id), parent.id],
  );
  await createReplyNoticeEffect(f.db.pool, f.accounts.access).run((await f.envelope(post.id)).events.find(Boolean)!);
  expect(await f.notices(post.id)).toEqual([]);
});
