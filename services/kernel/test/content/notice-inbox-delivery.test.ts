import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { contentNoticeEffects } from '../../src/content/relays.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';

let native: Awaited<ReturnType<typeof replyNoticeFixture>>;
let thread: Awaited<ReturnType<typeof native.thread>>;
const posts: string[] = [];
beforeAll(async () => {
  native = await replyNoticeFixture();
  thread = await native.thread();
  const effect = contentNoticeEffects(
    native.db.pool,
    createContentWorkAccess(() => new Date(), native.db.pool),
  ).find((candidate) => candidate.name === 'content_reply_notice')!;
  for (let i = 0; i < 3; i++) {
    const post = await native.post(thread.id);
    posts.push(post.id);
    await effect.run((await native.envelope(post.id)).events.find(Boolean)!);
  }
  // A concealed raw candidate must not change the visible range or leak its identifiers.
  const recipient = native.accounts.recipient;
  await native.db.admin.query(
    `INSERT INTO content.notice(route,recipient_id,notice_id,kind,thread_id,post_id,source_id,created_at)
     VALUES ($1,$2,$3,'reply',$4,$5,$5,now()+interval '1 minute')`,
    [routeOf(recipient), recipient, newId(routeOf(recipient)!), newId(0x4321), newId(0x4321)],
  );
}, 120_000);
afterAll(async () => native?.close());

function inbox(cursor?: string) {
  const query = new URLSearchParams({ limit: '1', ...(cursor === undefined ? {} : { cursor }) });
  return native.call(
    native.accounts.recipient,
    'GET',
    `/v1/accounts/${native.accounts.recipient}/notifications?${query}`,
  );
}

test('populated Inbox preserves cursor progress across concealed raw candidates', async () => {
  const first = await inbox();
  expect(first.status).toBe(200);
  expect(first.value.items.map((item: { postId: string }) => item.postId)).toEqual([posts[2]]);
  expect(first.value.next).toEqual(expect.any(String));
  const second = await inbox(first.value.next);
  expect(second.status).toBe(200);
  expect(second.value.items.map((item: { postId: string }) => item.postId)).toEqual([posts[1]]);
});

test('empty Inbox has no next cursor', async () => {
  const account = native.accounts.principal;
  expect(await native.call(account, 'GET', `/v1/accounts/${account}/notifications`)).toEqual({
    status: 200,
    value: { items: [], next: null },
  });
});

test('concealed viewers get 404 and concealed ordinary targets are omitted', async () => {
  expect(
    (await native.call(native.accounts.actor, 'GET', `/v1/accounts/${native.accounts.recipient}/notifications`)).status,
  ).toBe(404);
  const page = await native.call(
    native.accounts.recipient,
    'GET',
    `/v1/accounts/${native.accounts.recipient}/notifications?limit=50`,
  );
  expect(page.status).toBe(200);
  expect(page.value.items.map((item: { postId: string }) => item.postId)).toEqual([...posts].reverse());
});

test('unavailable Inbox sources return an error without a cursor', async () => {
  const lock = await native.db.admin.connect();
  try {
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE content.post IN ACCESS EXCLUSIVE MODE');
    const result = await inbox();
    expect(result.status).toBeGreaterThanOrEqual(500);
    expect(result.value).not.toHaveProperty('next');
    expect(result.value).not.toHaveProperty('items');
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
}, 30_000);

test('same-input operational retry repeats the raw range', async () => {
  const first = await inbox();
  const cursor = first.value.next;
  const read = await inbox(cursor);
  const retry = await inbox(cursor);
  expect(read.status).toBe(200);
  expect(retry.status).toBe(200);
  expect(read.value.items.map((item: { postId: string }) => item.postId)).toEqual([posts[1]]);
  expect(retry.value.items).toEqual(read.value.items);
});

test('explicit restart omits the cursor and returns the initial range', async () => {
  const first = await inbox();
  await inbox(first.value.next);
  const restarted = await inbox();
  expect(restarted.status).toBe(200);
  expect(restarted.value.items).toEqual(first.value.items);
});
