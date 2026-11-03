import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createThreadWatchNoticeEffect } from '../../src/content/watch-notices.ts';
import { eraseAccountNoticesPage } from '../../src/content/notices.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';

let f: Awaited<ReturnType<typeof replyNoticeFixture>>;
beforeAll(async () => {
  f = await replyNoticeFixture();
});
afterAll(async () => f?.close());

async function publishedEvent(postId: string): Promise<CloudEvent> {
  const envelope = await f.envelope(postId);
  return envelope.events.find(Boolean)!;
}

test('readers can privately watch a visible thread and clear their watch after access is revoked', async () => {
  const thread = await f.thread();
  const reader = f.accounts.principal;
  const path = `/v1/threads/${thread.id}/watch`;

  expect(await f.call(reader, 'GET', path)).toEqual({ status: 200, value: { watching: false } });
  expect(await f.call(reader, 'PUT', path)).toMatchObject({ status: 204 });
  expect(await f.call(reader, 'GET', path)).toEqual({ status: 200, value: { watching: true } });

  await f.db.admin.query(
    `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
     VALUES ($1,$2,$3,'thread:read','resource','(,)',$4)`,
    [routeOf(thread.id), thread.id, reader, newId(routeOf(thread.id)!)],
  );
  expect(await f.call(reader, 'DELETE', path)).toMatchObject({ status: 204 });
  expect(
    (
      await f.db.admin.query('SELECT 1 FROM content.thread_watch WHERE route=$1 AND thread_id=$2 AND watcher_account_id=$3', [
        routeOf(thread.id),
        thread.id,
        reader,
      ])
    ).rows,
  ).toHaveLength(0);
});

test('later replies reach current watchers once, and unwatch or a durable preference refusal prevents delivery', async () => {
  const effect = createThreadWatchNoticeEffect(f.db.pool, f.accounts.access);
  const reader = f.accounts.principal;
  const pathFor = (threadId: string) => `/v1/threads/${threadId}/watch`;

  const watched = await f.thread();
  await f.call(reader, 'PUT', pathFor(watched.id));
  const reply = await f.post(watched.id);
  const event = await publishedEvent(reply.id);
  await effect.run(event);
  await effect.run(event);
  expect((await f.notices(reply.id)).filter((notice) => notice.kind === 'thread_watch')).toMatchObject([
    { recipient_id: reader, kind: 'thread_watch', post_id: reply.id },
  ]);

  const unwatched = await f.thread();
  await f.call(reader, 'PUT', pathFor(unwatched.id));
  const unwatchedReply = await f.post(unwatched.id);
  const unwatchedEvent = await publishedEvent(unwatchedReply.id);
  await f.call(reader, 'DELETE', pathFor(unwatched.id));
  await effect.run(unwatchedEvent);
  expect((await f.notices(unwatchedReply.id)).filter((notice) => notice.kind === 'thread_watch')).toHaveLength(0);

  const optedOut = await f.thread();
  await f.call(reader, 'PUT', pathFor(optedOut.id));
  expect(
    await f.call(reader, 'PATCH', `/v1/accounts/${reader}/preferences`, {
      expectedVersion: 0,
      notifications: { thread_watch: false },
    }),
  ).toMatchObject({ status: 200 });
  const refusedReply = await f.post(optedOut.id);
  const refusedEvent = await publishedEvent(refusedReply.id);
  await effect.run(refusedEvent);
  const finalization = await f.db.admin.query(
    `SELECT sent FROM content.notice_finalization
     WHERE route=$1 AND recipient_id=$2 AND kind='thread_watch' AND source_id=$3`,
    [routeOf(reader), reader, refusedReply.id],
  );
  expect(finalization.rows).toEqual([{ sent: false }]);
  await f.call(reader, 'PATCH', `/v1/accounts/${reader}/preferences`, {
    expectedVersion: 1,
    notifications: { thread_watch: true },
  });
  await effect.run(refusedEvent);
  expect((await f.notices(refusedReply.id)).filter((notice) => notice.kind === 'thread_watch')).toHaveLength(0);

  let cursor: string | null = null;
  do {
    const page = await eraseAccountNoticesPage({ pool: f.db.pool }, reader, cursor);
    cursor = page.next;
  } while (cursor !== null);
  expect((await f.db.admin.query('SELECT 1 FROM content.thread_watch WHERE watcher_account_id=$1', [reader])).rows).toHaveLength(0);
}, 120_000);
