import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { normalizeDocument } from '@rezics/document';
import { contentNoticeEffects } from '../../src/content/relays.ts';
import { eraseAccountNoticesPage } from '../../src/content/notices.ts';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';
import { suspendAccount } from '../support/native-suspension-driver.ts';
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';
import { BOARD_WATCH_RECIPIENT_BUDGET, processBoardWatchNoticePage } from '../../src/content/board-watch-notices.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof replyNoticeFixture>>;
let initialWatchKey: string;
beforeAll(async () => {
  f = await replyNoticeFixture();
});
afterAll(async () => {
  await f?.close();
});
const path = () => `/v1/boards/${f.boardId}/watch`;
const management = (id: string, kind = 'board', limit = 20) => `/v1/accounts/${id}/watches?kind=${kind}&limit=${limit}`;
async function publication(postId: string) {
  return (await f.envelope(postId)).events.find(Boolean)!;
}
function effect() {
  // The default worker's native Access, rather than a test recipient-authorization callback.
  return contentNoticeEffects(
    f.db.pool,
    createContentWorkAccess(() => new Date(), f.db.pool),
  ).find((candidate) => candidate.name === 'content_board_watch_notice')!;
}

test('mounted board state uses CAS and exact retry, and delayed first opening sends once with independent preferences', async () => {
  const reader = f.accounts.principal;
  expect(await f.call(reader, 'GET', path())).toMatchObject({ status: 200, value: { watching: false, revision: 0 } });
  const key = (initialWatchKey = crypto.randomUUID());
  const input = { watching: true, expectedRevision: 0 };
  expect(await f.call(reader, 'PUT', path(), input, key)).toMatchObject({
    status: 200,
    value: { watching: true, revision: 1 },
  });
  expect(await f.call(reader, 'PUT', path(), input, key)).toMatchObject({
    status: 200,
    value: { watching: true, revision: 1 },
  });
  expect((await f.call(reader, 'PUT', path(), { watching: false, expectedRevision: 0 })).status).toBe(409);
  expect(
    (
      await f.call(reader, 'PATCH', `/v1/accounts/${reader}/preferences`, {
        expectedVersion: 0,
        notifications: { thread_watch: false, board_activity: true },
      })
    ).status,
  ).toBe(200);
  const draft = await f.thread(f.accounts.recipient, 'draft');
  const published = await f.call(f.accounts.recipient, 'POST', `/v1/posts/${draft.firstPost.id}/revisions`, {
    body: normalizeDocument({
      version: 'rezics-document-v1',
      profile: 'text',
      doc: {
        type: 'doc',
        content: [
          { type: 'paragraph', attrs: { id: 'opening' }, content: [{ type: 'mention', attrs: { accountId: reader } }] },
        ],
      },
    }),
    licence: 'MIT',
    subjectIds: [],
    visibility: 'published',
  });
  expect(published.status).toBe(200);
  const event = await publication(draft.firstPost.id);
  await effect().run(event);
  await effect().run(event);
  await contentNoticeEffects(
    f.db.pool,
    createContentWorkAccess(() => new Date(), f.db.pool),
  )
    .find((candidate) => candidate.name === 'content_mention_notice')!
    .run(event);
  expect(await f.notices(draft.firstPost.id)).toHaveLength(1);
  expect((await f.notices(draft.firstPost.id)).filter((notice) => notice.kind === 'board_activity')).toMatchObject([
    { recipient_id: reader, post_id: draft.firstPost.id },
  ]);
  const reply = await f.post(draft.id);
  await effect().run(await publication(reply.id));
  expect((await f.notices(reply.id)).filter((notice) => notice.kind === 'board_activity')).toHaveLength(0);
  expect((await f.call(reader, 'GET', `/v1/accounts/${reader}/notifications`)).value.items).toContainEqual(
    expect.objectContaining({ kind: 'board_activity', postId: draft.firstPost.id }),
  );
  const suppressed = await f.thread();
  expect(
    (
      await f.call(reader, 'PATCH', `/v1/accounts/${reader}/preferences`, {
        expectedVersion: 1,
        notifications: { board_activity: false, thread_watch: true },
      })
    ).status,
  ).toBe(200);
  await effect().run(await publication(suppressed.firstPost.id));
  expect(
    (
      await f.db.admin.query(
        `SELECT sent FROM content.notice_finalization
    WHERE recipient_id=$1 AND source_id=$2 AND kind='board_activity'`,
        [reader, suppressed.firstPost.id],
      )
    ).rows,
  ).toEqual([{ sent: false }]);
  await f.call(reader, 'PATCH', `/v1/accounts/${reader}/preferences`, {
    expectedVersion: 2,
    notifications: { board_activity: true },
  });
  await effect().run(await publication(suppressed.firstPost.id));
  expect((await f.notices(suppressed.firstPost.id)).filter((notice) => notice.kind === 'board_activity')).toHaveLength(
    0,
  );
});

test('withdrawal closes a started opening before restoration can reach its remaining permitted subscriber', async () => {
  const missing = Array.from({ length: 2 * BOARD_WATCH_RECIPIENT_BUDGET + 1 }, () => newId(0x7654));
  await f.db.admin.query(
    `INSERT INTO content.board_watch(route,watcher_account_id,board_id,watch_id,watching,revision,created_at)
     SELECT $1,recipient,$2,watch,true,1,clock_timestamp() FROM unnest($3::uuid[],$4::uuid[]) n(recipient,watch)`,
    [0x7654, f.boardId, missing, missing.map(() => newId(0x7654))],
  );
  try {
    const reader = f.accounts.recipient;
    expect((await f.call(reader, 'PUT', path(), { watching: true, expectedRevision: 0 })).status).toBe(200);
    const opening = await f.thread(f.accounts.principal);
    const event = await publication(opening.firstPost.id);
    const access = createContentWorkAccess(() => new Date(), f.db.pool);
    expect(await processBoardWatchNoticePage(f.db.pool, access, event)).toEqual({
      done: false,
      scanned: BOARD_WATCH_RECIPIENT_BUDGET,
    });
    await f.db.admin.query("UPDATE content.thread SET visibility='draft' WHERE thread_id=$1", [opening.id]);
    expect(await processBoardWatchNoticePage(f.db.pool, access, event)).toEqual({ done: true, scanned: 0 });
    await f.db.admin.query("UPDATE content.thread SET visibility='published' WHERE thread_id=$1", [opening.id]);
    await effect().run(event);
    expect(await f.notices(opening.firstPost.id)).toEqual([]);
  } finally {
    await f.db.admin.query('DELETE FROM content.board_watch WHERE watcher_account_id=ANY($1::uuid[])', [missing]);
  }
});

test('one private reader pages explicit kinds, conceals unavailable targets and removes by personal identity after denial', async () => {
  const reader = f.accounts.principal;
  const visible = await f.thread();
  const denied = await f.thread();
  for (const thread of [visible, denied])
    expect((await f.call(reader, 'PUT', `/v1/threads/${thread.id}/watch`)).status).toBe(204);
  await f.db.admin.query(
    `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
    VALUES($1,$2,$3,'thread:read','resource','(,)',$4)`,
    [routeOf(denied.id), denied.id, reader, newId(routeOf(denied.id)!)],
  );
  const first = await f.call(reader, 'GET', management(reader, 'thread', 1));
  expect(first.status).toBe(200);
  expect(first.value.items).toHaveLength(1);
  expect(first.value.next).toBeString();
  expect(
    (await f.call(f.accounts.actor, 'GET', `${management(f.accounts.actor, 'thread', 1)}&cursor=${first.value.next}`))
      .status,
  ).toBe(400);
  expect((await f.call(reader, 'GET', `${management(reader, 'board', 1)}&cursor=${first.value.next}`)).status).toBe(
    400,
  );
  expect((await f.call(f.accounts.actor, 'GET', management(reader, 'thread'))).status).toBe(404);
  const second = await f.call(reader, 'GET', `${management(reader, 'thread', 1)}&cursor=${first.value.next}`);
  expect(second.status).toBe(200);
  const row = second.value.items[0];
  expect(row).toEqual({
    id: expect.any(String),
    kind: 'thread',
    revision: 1,
    createdAt: expect.any(String),
    state: 'unavailable',
  });
  const removePath = `/v1/accounts/${reader}/watches/${row.id}?kind=thread`;
  const key = crypto.randomUUID();
  expect((await f.call(reader, 'DELETE', removePath, { expectedRevision: row.revision }, key)).status).toBe(200);
  expect((await f.call(reader, 'DELETE', removePath, { expectedRevision: row.revision }, key)).status).toBe(200);
  expect((await f.call(reader, 'GET', management(reader, 'thread'))).value.items).toMatchObject([
    { state: 'available', resourceId: visible.id },
  ]);
  const board = (await f.call(reader, 'GET', management(reader))).value.items[0];
  await f.db.admin.query(
    `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
    VALUES($1,$2,$3,'board:read','resource','(,)',$4)`,
    [routeOf(f.boardId), f.boardId, reader, newId(routeOf(f.boardId)!)],
  );
  expect((await f.call(reader, 'GET', management(reader))).value.items).toEqual([
    { id: board.id, kind: 'board', revision: board.revision, createdAt: board.createdAt, state: 'unavailable' },
  ]);
  expect(
    (
      await f.call(reader, 'DELETE', `/v1/accounts/${reader}/watches/${board.id}?kind=board`, {
        expectedRevision: board.revision,
      })
    ).status,
  ).toBe(200);
  // A retry that would watch cannot replay its former success after current source authority was lost.
  expect((await f.call(reader, 'PUT', path(), { watching: true, expectedRevision: 0 }, initialWatchKey)).status).toBe(
    404,
  );
  expect((await f.call(reader, 'GET', management(reader))).value.items).toEqual([]);
});

test('unwatch, erasure and late replay cannot recreate subscriptions or old notice presentation', async () => {
  const reader = f.accounts.actor;
  expect((await f.call(reader, 'PUT', path(), { watching: true, expectedRevision: 0 })).status).toBe(200);
  const opening = await f.thread();
  const event = await publication(opening.firstPost.id);
  expect((await f.call(reader, 'PUT', path(), { watching: false, expectedRevision: 1 })).status).toBe(200);
  await effect().run(event);
  expect((await f.notices(opening.firstPost.id)).filter((notice) => notice.recipient_id === reader)).toHaveLength(0);
  expect((await f.call(reader, 'PUT', path(), { watching: true, expectedRevision: 2 })).status).toBe(200);
  await effect().run(event);
  expect((await f.notices(opening.firstPost.id)).filter((notice) => notice.recipient_id === reader)).toHaveLength(0);
  const suspendedOpening = await f.thread();
  const suspendedEvent = await publication(suspendedOpening.firstPost.id);
  configureTestReceiptKeys(f.db.admin);
  await suspendAccount(f.db.admin, reader);
  expect((await f.call(reader, 'GET', management(reader))).status).toBe(401);
  await effect().run(suspendedEvent);
  expect(
    (
      await f.db.admin.query(
        `SELECT sent FROM content.notice_finalization
    WHERE recipient_id=$1 AND source_id=$2 AND kind='board_activity'`,
        [reader, suspendedOpening.firstPost.id],
      )
    ).rows,
  ).toEqual([{ sent: false }]);
  let cursor: string | null = null;
  do {
    cursor = (await eraseAccountNoticesPage({ pool: f.db.pool }, reader, cursor)).next;
  } while (cursor);
  await effect().run(event);
  expect(
    (await f.db.admin.query('SELECT 1 FROM content.board_watch WHERE watcher_account_id=$1', [reader])).rows,
  ).toEqual([]);
  expect((await f.notices(opening.firstPost.id)).filter((notice) => notice.recipient_id === reader)).toHaveLength(0);
});
