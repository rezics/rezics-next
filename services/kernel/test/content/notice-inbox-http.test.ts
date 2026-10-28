import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { reactionFixture } from './reactions.test.ts';
import type { GrowthDatabase } from '../support/growth.ts';

let fixture: Awaited<ReturnType<typeof reactionFixture>>;
let kernel: ReturnType<typeof createKernel>;
let db: GrowthDatabase;
beforeAll(async () => {
  fixture = await reactionFixture();
  db = fixture.db;
  kernel = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(71),
    access: fixture.access,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) },
  });
}, 120_000);
afterAll(async () => fixture?.close());

async function call(path: string, method = 'GET', body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${fixture.bearer()}`,
        ...(body === undefined
          ? {}
          : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, value: response.status === 204 ? null : ((await response.json()) as any) };
}

async function seed(count: number) {
  await db.admin.query('TRUNCATE TABLE content.notice, content.notice_seen');
  const recipient = fixture.accountId;
  const r = routeOf(recipient)!;
  const ids = Array.from({ length: count }, (_, i) => newId(r));
  await db.admin.query(
    `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
     SELECT $1,$2,x,'moderation_decision',x,'2026-10-27T00:00:00Z'::timestamptz + i * interval '1 second'
     FROM unnest($3::uuid[]) WITH ORDINALITY AS v(x,i)`,
    [r, recipient, ids],
  );
  return ids;
}

test("the inbox lists only the viewer's notices newest first with an opaque cursor, and another account's inbox answers 404", async () => {
  const ids = await seed(3);
  const base = `/v1/accounts/${fixture.accountId}/notifications`;
  const first = await call(`${base}?limit=1`);
  expect(first.response.status).toBe(200);
  expect(first.value.items[0].id).toBe(ids[2]);
  expect(first.value.next).toEqual(expect.any(String));
  expect(first.value.next).not.toContain(ids[2]);
  const second = await call(`${base}?limit=1&cursor=${encodeURIComponent(first.value.next)}`);
  expect(second.value.items[0].id).toBe(ids[1]);
  expect((await call(`/v1/accounts/${newId(0x7131)}/notifications`)).response.status).toBe(404);
  const hiddenId = newId(routeOf(fixture.accountId)!);
  const hiddenMentionId = newId(routeOf(fixture.accountId)!);
  const inaccessiblePost = newId(fixture.targetRoute);
  await db.admin.query(
    `INSERT INTO content.notice(route,recipient_id,notice_id,kind,thread_id,post_id,source_id,created_at)
     VALUES ($1,$2,$3,'reply',$4,$5,$3,now()+interval '1 minute'),
            ($1,$2,$6,'mention',$4,$5,$6,now()+interval '2 minutes')`,
    [
      routeOf(fixture.accountId),
      fixture.accountId,
      hiddenId,
      newId(fixture.targetRoute),
      inaccessiblePost,
      hiddenMentionId,
    ],
  );
  const filtered = await call(`${base}?limit=50`);
  expect(
    filtered.value.items.map((item: { id: string; postId: string | null }) => [item.id, item.postId]),
  ).not.toContainEqual([hiddenId, inaccessiblePost]);
  expect(
    filtered.value.items.map((item: { id: string; postId: string | null }) => [item.id, item.postId]),
  ).not.toContainEqual([hiddenMentionId, inaccessiblePost]);
  expect(JSON.stringify(filtered.value)).not.toContain(inaccessiblePost);
});

test('the unread count stops at 100 and the seen marker never moves backward', async () => {
  const ids = await seed(102);
  const base = `/v1/accounts/${fixture.accountId}/notifications`;
  expect((await call(`${base}/count`)).value).toEqual({ count: 100, capped: true });
  const advanced = await call(`${base}:markSeen`, 'POST', { through: ids[80] });
  expect(advanced.response.status).toBe(204);
  expect((await call(`${base}:markSeen`, 'POST', { through: ids[12] })).response.status).toBe(204);
  expect((await call(`${base}/count`)).value).toEqual({ count: 21, capped: false });
});
