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
import { interceptThreadSnapshot } from './support/watch-management-fixture.ts';

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
  const firstWatchId = (
    await f.db.admin.query<{ watch_id: string }>(
      'SELECT watch_id FROM content.board_watch WHERE board_id=$1 AND watcher_account_id=$2',
      [f.boardId, reader],
    )
  ).rows[0]!.watch_id;
  expect(await f.call(reader, 'PUT', path(), input, key)).toMatchObject({
    status: 200,
    value: { watching: true, revision: 1 },
  });
  expect((await f.call(reader, 'PUT', path(), { watching: false, expectedRevision: 0 })).status).toBe(409);
  expect(
    await f.call(reader, 'PUT', path(), { watching: false, expectedRevision: 1 }, crypto.randomUUID()),
  ).toMatchObject({
    status: 200,
    value: { watching: false, revision: 2 },
  });
  expect(
    await f.call(reader, 'PUT', path(), { watching: true, expectedRevision: 2 }, crypto.randomUUID()),
  ).toMatchObject({
    status: 200,
    value: { watching: true, revision: 3 },
  });
  const restartedWatchId = (
    await f.db.admin.query<{ watch_id: string }>(
      'SELECT watch_id FROM content.board_watch WHERE board_id=$1 AND watcher_account_id=$2',
      [f.boardId, reader],
    )
  ).rows[0]!.watch_id;
  expect(restartedWatchId).not.toBe(firstWatchId);
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
        expectedRevision: board.revision + 1,
      })
    ).status,
  ).toBe(409);
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
  expect((await f.call(reader, 'GET', management(reader))).value).toEqual({ items: [], next: null });
});

test('board stop and restart rotate the private episode identity and reject stale CAS revisions', async () => {
  const reader = f.accounts.actor;
  const route = routeOf(reader)!;
  const boardPath = `/v1/boards/${f.boardId}/watch`;
  await f.db.admin.query('DELETE FROM content.board_watch WHERE route=$1 AND watcher_account_id=$2', [route, reader]);
  expect((await f.call(reader, 'GET', boardPath)).value).toEqual({ watching: false, revision: 0 });
  expect((await f.call(reader, 'PUT', boardPath, { watching: true, expectedRevision: 0 })).value).toEqual({
    watching: true,
    revision: 1,
  });
  const first = (
    await f.db.admin.query('SELECT watch_id FROM content.board_watch WHERE route=$1 AND watcher_account_id=$2', [
      route,
      reader,
    ])
  ).rows[0]!.watch_id as string;
  expect((await f.call(reader, 'PUT', boardPath, { watching: false, expectedRevision: 1 })).value).toEqual({
    watching: false,
    revision: 2,
  });
  expect((await f.call(reader, 'PUT', boardPath, { watching: true, expectedRevision: 1 })).status).toBe(409);
  expect((await f.call(reader, 'PUT', boardPath, { watching: true, expectedRevision: 2 })).value).toEqual({
    watching: true,
    revision: 3,
  });
  const second = (
    await f.db.admin.query('SELECT watch_id FROM content.board_watch WHERE route=$1 AND watcher_account_id=$2', [
      route,
      reader,
    ])
  ).rows[0]!.watch_id as string;
  expect(second).not.toBe(first);
  expect((await f.call(reader, 'PUT', boardPath, { watching: false, expectedRevision: 2 })).status).toBe(409);
  expect((await f.call(reader, 'GET', management(reader, 'board'))).value.items).toMatchObject([
    { id: second, state: 'available', resourceId: f.boardId, revision: 3 },
  ]);
  await f.db.admin.query('DELETE FROM content.board_watch WHERE route=$1 AND watcher_account_id=$2', [route, reader]);
});

test('empty inventory is terminal and a full sparse raw page returns no refill before same-cursor continuation', async () => {
  const reader = f.accounts.actor;
  const route = routeOf(reader)!;
  await f.db.admin.query('DELETE FROM content.thread_watch WHERE route=$1 AND watcher_account_id=$2', [route, reader]);
  expect((await f.call(reader, 'GET', management(reader, 'thread', 20))).value).toEqual({ items: [], next: null });

  const first = await f.thread();
  const watchIds = Array.from({ length: 100 }, () => newId(route));
  const targets = [first.id, ...Array.from({ length: 99 }, () => newId(route))];
  await f.db.admin.query(
    `INSERT INTO content.thread_watch(route,watch_id,thread_id,watcher_account_id,created_at)
     SELECT $1,watch,thread,$2,'2026-11-01T00:00:00Z'::timestamptz + ordinal * interval '1 second'
     FROM unnest($3::uuid[],$4::uuid[]) WITH ORDINALITY n(watch,thread,ordinal)`,
    [route, reader, watchIds, targets],
  );
  const gate = interceptThreadSnapshot(f.db.pool, first.id, 'pause');
  try {
    const pending = f.call(reader, 'GET', management(reader, 'thread', 20));
    await gate.reached;
    await f.db.admin.query('DELETE FROM content.thread_watch WHERE watch_id=ANY($1::uuid[])', [watchIds]);
    gate.release();
    const sparse = await pending;
    expect(sparse.status).toBe(200);
    expect(sparse.value.items).toEqual([]);
    expect(sparse.value.next).toBeString();
    const continued = await f.call(
      reader,
      'GET',
      `${management(reader, 'thread', 20)}&cursor=${encodeURIComponent(sparse.value.next)}`,
    );
    expect(continued).toMatchObject({ status: 200, value: { items: [], next: null } });
  } finally {
    gate.restore();
    await f.db.admin.query('DELETE FROM content.thread_watch WHERE watch_id=ANY($1::uuid[])', [watchIds]);
  }
});

test('inventory retries a reused source identity and the exact same cursor after an unavailable native read', async () => {
  const reader = f.accounts.actor;
  const route = routeOf(reader)!;
  await f.db.admin.query('DELETE FROM content.thread_watch WHERE route=$1 AND watcher_account_id=$2', [route, reader]);
  const first = await f.thread();
  const later = await f.thread();
  for (const thread of [first, later])
    expect((await f.call(reader, 'PUT', `/v1/threads/${thread.id}/watch`)).status).toBe(204);
  const watches = (
    await f.db.admin.query(
      `SELECT watch_id,thread_id FROM content.thread_watch WHERE route=$1 AND watcher_account_id=$2`,
      [route, reader],
    )
  ).rows as { watch_id: string; thread_id: string }[];
  const firstWatch = watches.find((row) => row.thread_id === first.id)!;
  const laterWatch = watches.find((row) => row.thread_id === later.id)!;
  await f.db.admin.query(
    `UPDATE content.thread_watch SET created_at=CASE watch_id WHEN $1 THEN '2026-11-01T00:00:00Z'::timestamptz
       ELSE '2026-11-02T00:00:00Z'::timestamptz END WHERE watch_id=ANY($2::uuid[])`,
    [firstWatch.watch_id, [firstWatch.watch_id, laterWatch.watch_id]],
  );

  const sourceGate = interceptThreadSnapshot(f.db.pool, later.id, 'pause');
  try {
    const pending = f.call(reader, 'GET', management(reader, 'thread', 20));
    await sourceGate.reached;
    await f.db.admin.query('DELETE FROM content.thread_watch WHERE watch_id=$1', [firstWatch.watch_id]);
    await f.db.admin.query(
      `INSERT INTO content.thread_watch(route,thread_id,watcher_account_id,watch_id,created_at)
       VALUES($1,$2,$3,$4,'2026-11-01T12:00:00Z'::timestamptz)`,
      [route, first.id, reader, firstWatch.watch_id],
    );
    sourceGate.release();
    expect((await pending).status).toBe(503);
  } finally {
    sourceGate.restore();
  }
  expect((await f.call(reader, 'GET', management(reader, 'thread', 20))).value.items).toContainEqual(
    expect.objectContaining({ id: firstWatch.watch_id, resourceId: first.id, createdAt: '2026-11-01T12:00:00.000Z' }),
  );

  const cursorPage = await f.call(reader, 'GET', management(reader, 'thread', 1));
  expect(cursorPage.status).toBe(200);
  const cursor = cursorPage.value.next as string;
  expect(cursor).toBeString();
  const retryPath = `${management(reader, 'thread', 1)}&cursor=${encodeURIComponent(cursor)}`;
  const failureGate = interceptThreadSnapshot(f.db.pool, later.id, 'fail');
  try {
    expect((await f.call(reader, 'GET', retryPath)).status).toBe(503);
  } finally {
    failureGate.restore();
  }
  expect(await f.call(reader, 'GET', retryPath)).toMatchObject({
    status: 200,
    value: { items: [{ resourceId: later.id, state: 'available' }], next: null },
  });
});

test('inventory finishes current target disclosure after later rows hydrate', async () => {
  const reader = f.accounts.actor;
  const accountRoute = routeOf(reader)!;
  const route = routeOf(f.boardId)!;
  const secondaryBoard = newId(route);
  const space = newId(route);
  const realm = newId(route);
  const spaceRevision = newId(route);
  const realmRevision = newId(route);
  const context = newId(route);
  const setup = await f.db.admin.connect();
  try {
    await setup.query('BEGIN');
    await setup.query("SET LOCAL plpgsql.variable_conflict = 'use_column'");
    await setup.query('SET CONSTRAINTS ALL DEFERRED');
    await setup.query(
      `INSERT INTO community.space(route,space_id,state,head_revision_id,created_at,creator)
       VALUES($1,$2,'active',$3,clock_timestamp(),$4)`,
      [route, space, spaceRevision, f.accounts.recipient],
    );
    await setup.query(
      `INSERT INTO community.space_revision(route,space_id,revision_id,title,summary,created_at,author)
       VALUES($1,$2,$3,'Watch space','',clock_timestamp(),$4)`,
      [route, space, spaceRevision, f.accounts.recipient],
    );
    await setup.query(
      `INSERT INTO community.realm(route,realm_id,space_id,state,visibility,context_id,head_revision_id,created_at,creator)
       VALUES($1,$2,$3,'active','public',$4,$5,clock_timestamp(),$6)`,
      [route, realm, space, context, realmRevision, f.accounts.recipient],
    );
    await setup.query(
      `INSERT INTO community.realm_revision(route,realm_id,revision_id,title,summary,visibility,context_id,created_at,author)
       VALUES($1,$2,$3,'Watch realm','','public',$4,clock_timestamp(),$5)`,
      [route, realm, realmRevision, context, f.accounts.recipient],
    );
    await setup.query(
      `INSERT INTO content.board(route,board_id,subject_id,title,realm_id,visibility,security_revision,recorded_transaction_id)
       VALUES($1,$2,$3,'Realm watch board',$4,'published',1,$5)`,
      [route, secondaryBoard, newId(route), realm, crypto.randomUUID()],
    );
    await setup.query('COMMIT');
  } catch (error) {
    await setup.query('ROLLBACK');
    throw error;
  } finally {
    setup.release();
  }
  await f.accounts.grant(reader, 'realm:read', { route, id: realm });
  await f.accounts.grant(reader, 'realm:participate', { route, id: realm });
  await f.accounts.grant(reader, 'board:read', { route, id: secondaryBoard });
  const realmThread = await f.thread();
  await f.db.admin.query(
    'UPDATE content.thread SET board_id=$2,security_revision=security_revision+1 WHERE thread_id=$1',
    [realmThread.id, secondaryBoard],
  );
  const later = await f.thread();
  for (const thread of [realmThread, later])
    expect((await f.call(reader, 'PUT', `/v1/threads/${thread.id}/watch`)).status).toBe(204);
  await f.db.admin.query(
    `UPDATE content.thread_watch SET created_at=CASE thread_id WHEN $1 THEN '2026-11-01T00:00:00Z'::timestamptz
       ELSE '2026-11-02T00:00:00Z'::timestamptz END WHERE watcher_account_id=$2 AND thread_id=ANY($3::uuid[])`,
    [realmThread.id, reader, [realmThread.id, later.id]],
  );

  const targetGate = interceptThreadSnapshot(f.db.pool, later.id, 'pause');
  try {
    const pending = f.call(reader, 'GET', management(reader, 'thread', 20));
    await targetGate.reached;
    await f.db.admin.query(
      'UPDATE content.thread SET board_id=$2,security_revision=security_revision+1 WHERE thread_id=$1',
      [realmThread.id, f.boardId],
    );
    targetGate.release();
    expect((await pending).status).toBe(503);
  } finally {
    targetGate.restore();
  }
  expect((await f.call(reader, 'GET', management(reader, 'thread', 20))).value.items).toContainEqual(
    expect.objectContaining({ id: expect.any(String), resourceId: realmThread.id, state: 'available' }),
  );

  const revokedThread = await f.thread(f.accounts.recipient, 'published', secondaryBoard);
  expect((await f.call(reader, 'PUT', `/v1/threads/${revokedThread.id}/watch`)).status).toBe(204);
  await f.db.admin.query(
    `UPDATE content.thread_watch SET created_at='2026-10-31T00:00:00Z'::timestamptz WHERE thread_id=$1 AND watcher_account_id=$2`,
    [revokedThread.id, reader],
  );
  const revokedWatch = (
    await f.db.admin.query('SELECT watch_id FROM content.thread_watch WHERE thread_id=$1 AND watcher_account_id=$2', [
      revokedThread.id,
      reader,
    ])
  ).rows[0]!.watch_id as string;
  const realmDenial = newId(route);
  const realmGate = interceptThreadSnapshot(f.db.pool, later.id, 'pause');
  try {
    const pending = f.call(reader, 'GET', management(reader, 'thread', 20));
    await realmGate.reached;
    await f.db.admin.query(
      `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
       VALUES($1,$2,$3,'realm:read','resource','(,)',$4)`,
      [route, realm, reader, realmDenial],
    );
    realmGate.release();
    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.value.items).toContainEqual({
      id: revokedWatch,
      kind: 'thread',
      revision: 1,
      createdAt: '2026-10-31T00:00:00.000Z',
      state: 'unavailable',
    });
  } finally {
    realmGate.restore();
    await f.db.admin.query('DELETE FROM access.resource_denial WHERE transaction_id=$1', [realmDenial]);
  }

  const removalThread = await f.thread(f.accounts.recipient, 'published', secondaryBoard);
  expect((await f.call(reader, 'PUT', `/v1/threads/${removalThread.id}/watch`)).status).toBe(204);
  await f.db.admin.query(
    `UPDATE content.thread_watch SET created_at='2026-11-01T00:00:00Z'::timestamptz WHERE thread_id=$1 AND watcher_account_id=$2`,
    [removalThread.id, reader],
  );
  const removalWatch = (
    await f.db.admin.query('SELECT watch_id FROM content.thread_watch WHERE thread_id=$1 AND watcher_account_id=$2', [
      removalThread.id,
      reader,
    ])
  ).rows[0]!.watch_id as string;
  const removalGate = interceptThreadSnapshot(f.db.pool, later.id, 'pause');
  try {
    const pending = f.call(reader, 'GET', management(reader, 'thread', 20));
    await removalGate.reached;
    await f.db.admin.query("UPDATE content.thread SET visibility='draft' WHERE thread_id=$1", [removalThread.id]);
    removalGate.release();
    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.value.items).toContainEqual({
      id: removalWatch,
      kind: 'thread',
      revision: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      state: 'unavailable',
    });
  } finally {
    removalGate.restore();
  }
  const removePath = `/v1/accounts/${reader}/watches/${removalWatch}?kind=thread`;
  const removalKey = crypto.randomUUID();
  expect((await f.call(reader, 'DELETE', removePath, { expectedRevision: 1 }, removalKey)).status).toBe(200);
  expect((await f.call(reader, 'DELETE', removePath, { expectedRevision: 1 }, removalKey)).status).toBe(200);
  expect((await f.call(reader, 'GET', management(reader, 'thread', 20))).value.items).not.toContainEqual(
    expect.objectContaining({ id: removalWatch }),
  );
  await f.db.admin.query(
    'DELETE FROM content.thread_watch WHERE route=$1 AND watcher_account_id=$2 AND thread_id=ANY($3::uuid[])',
    [accountRoute, reader, [realmThread.id, later.id, revokedThread.id, removalThread.id]],
  );
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
  const ownerRoute = routeOf(reader)!;
  await f.db.admin.query('DELETE FROM content.thread_watch WHERE route=$1 AND watcher_account_id=$2', [
    ownerRoute,
    reader,
  ]);
  const first = await f.thread();
  const later = await f.thread();
  for (const thread of [first, later])
    expect((await f.call(reader, 'PUT', `/v1/threads/${thread.id}/watch`)).status).toBe(204);
  await f.db.admin.query(
    `UPDATE content.thread_watch SET created_at=CASE thread_id WHEN $1 THEN '2026-11-01T00:00:00Z'::timestamptz
       ELSE '2026-11-02T00:00:00Z'::timestamptz END WHERE watcher_account_id=$2 AND thread_id=ANY($3::uuid[])`,
    [first.id, reader, [first.id, later.id]],
  );
  const suspendedOpening = await f.thread();
  const suspendedEvent = await publication(suspendedOpening.firstPost.id);
  configureTestReceiptKeys(f.db.admin);
  const sessionGate = interceptThreadSnapshot(f.db.pool, later.id, 'pause');
  try {
    const pending = f.call(reader, 'GET', management(reader, 'thread', 20));
    await sessionGate.reached;
    await suspendAccount(f.db.admin, reader);
    sessionGate.release();
    expect((await pending).status).toBe(404);
  } finally {
    sessionGate.restore();
  }
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
