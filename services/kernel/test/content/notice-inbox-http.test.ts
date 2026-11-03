import { afterAll, beforeAll, expect, test } from 'bun:test';
import { deleteExpiredNoticesPage } from '../../src/content/notices.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { reactionFixture } from './reactions.test.ts';
import type { GrowthDatabase } from '../support/growth.ts';
import { createContentNotificationDriver } from './notification-driver.ts';

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
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, value: response.status === 204 ? null : ((await response.json()) as any) };
}

async function seed(count: number) {
  await db.admin.query('TRUNCATE TABLE content.notice_ack, content.notice, content.notice_seen');
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
     VALUES ($1,$2,$3,'reply',$4,$5,$5,now()+interval '1 minute'),
            ($1,$2,$6,'mention',$4,$5,$5,now()+interval '2 minutes')`,
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

test('the Inbox and unread summary omit notices without a current disclosed source', async () => {
  const disclosed = await seed(3);
  const hiddenIds = Array.from({ length: 5 }, () => newId(routeOf(fixture.accountId)!));
  const hiddenPost = newId(fixture.targetRoute);
  await db.admin.query(
    `INSERT INTO content.notice(route,recipient_id,notice_id,kind,thread_id,post_id,source_id,created_at)
     SELECT $1,$2,id,'reply',$3,$4,$4,now() + ordinality * interval '1 minute'
     FROM unnest($5::uuid[]) WITH ORDINALITY AS notices(id,ordinality)`,
    [routeOf(fixture.accountId), fixture.accountId, newId(fixture.targetRoute), hiddenPost, hiddenIds],
  );
  const base = `/v1/accounts/${fixture.accountId}/notifications`;
  const page = await call(`${base}?limit=50`);
  expect(page.response.status).toBe(200);
  expect(page.value.items.map((item: { id: string }) => item.id)).toEqual([...disclosed].reverse());
  expect(JSON.stringify(page.value)).not.toContain(hiddenPost);
  expect((await call(`${base}/count`)).value).toMatchObject({
    count: disclosed.length,
    capped: false,
    basis: 'current-visible-unread',
    witness: { kind: 'current-disclosure', at: expect.any(String) },
  });
});

test('the unread count stops at 100 and the seen marker never moves backward', async () => {
  const ids = await seed(102);
  const base = `/v1/accounts/${fixture.accountId}/notifications`;
  expect((await call(`${base}/count`)).value).toMatchObject({
    count: 100,
    capped: false,
    basis: 'current-visible-unread',
  });
  const advanced = await call(`${base}:markSeen`, 'POST', { through: ids[80] });
  expect(advanced.response.status).toBe(204);
  expect((await call(`${base}:markSeen`, 'POST', { through: ids[12] })).response.status).toBe(204);
  expect((await call(`${base}/count`)).value).toMatchObject({
    count: 21,
    capped: false,
    basis: 'current-visible-unread',
  });
});

test('one-item acknowledgement is exact, concurrent-safe and independent of the bulk frontier', async () => {
  const ids = await seed(3);
  const base = `/v1/accounts/${fixture.accountId}/notifications`;
  const target = ids[1]!;
  const path = `${base}/${target}:markSeen`;
  const results = await Promise.all([call(path, 'POST'), call(path, 'POST')]);
  expect(results.map((result) => result.response.status)).toEqual([204, 204]);
  const page = await call(`${base}?limit=10`);
  const flags = new Map(page.value.items.map((item: { id: string; unread: boolean }) => [item.id, item.unread]));
  expect(flags.get(target)).toBe(false);
  expect(ids.filter((id) => id !== target).every((id) => flags.get(id) === true)).toBe(true);
  expect(
    await db.admin.query('SELECT count(*)::integer AS count FROM content.notice_seen WHERE route=$1 AND account_id=$2', [
      routeOf(fixture.accountId),
      fixture.accountId,
    ]),
  ).toMatchObject({ rows: [{ count: 0 }] });
  expect((await call(`${base}/count`)).value).toMatchObject({ count: 2, capped: false });
});

test('retention preserves the precise seen frontier across delayed delivery and concurrent marks', async () => {
  const ids = (await seed(105)).sort();
  const r = routeOf(fixture.accountId)!;
  const base = `/v1/accounts/${fixture.accountId}/notifications`;
  const mark = (through: string) => call(`${base}:markSeen`, 'POST', { through });
  const count = async () => (await call(`${base}/count`)).value;
  const flags = async () => {
    const items: Array<{ id: string; unread: boolean }> = [];
    let cursor = '';
    do {
      const page = await call(`${base}?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      items.push(...page.value.items.map(({ id, unread }: { id: string; unread: boolean }) => ({ id, unread })));
      cursor = page.value.next;
    } while (cursor);
    return items;
  };
  await db.admin.query(
    `UPDATE content.notice n SET created_at='2026-01-01T00:00:00Z'::timestamptz +
       CASE WHEN i=105 THEN interval '999 microseconds' WHEN i=104 THEN interval '998 microseconds'
            WHEN i=103 THEN interval '1000 microseconds' WHEN i<=2 THEN interval '1001 microseconds'
            ELSE interval '2000 microseconds' END
     FROM unnest($1::uuid[]) WITH ORDINALITY AS v(id,i) WHERE n.route=$2 AND n.notice_id=v.id`,
    [ids, r],
  );
  expect((await mark(ids[104]!)).response.status).toBe(204);
  const before = await flags();
  expect(before.filter((item) => !item.unread).map((item) => item.id)).toEqual([ids[104]!, ids[103]!]);
  expect(await count()).toEqual({ count: 100, capped: true });
  expect(await deleteExpiredNoticesPage(db.pool, r, new Date('2026-01-01T00:00:00.001Z'))).toBe(2);
  expect(await flags()).toEqual(before.filter((item) => item.unread));
  const delayed = newId(r);
  await db.admin.query(
    `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
     VALUES ($1,$2,$3,'moderation_decision',$3,'2026-01-01T00:00:00.000998Z')`,
    [r, fixture.accountId, delayed],
  );
  expect((await flags()).at(-1)).toEqual({ id: delayed, unread: false });
  expect((await mark(ids[104]!)).response.status).toBe(404);
  await mark(ids[0]!);
  expect(await count()).toEqual({ count: 100, capped: true });
  await mark(ids[1]!);
  expect(await count()).toEqual({ count: 100, capped: false });
  await mark(ids[102]!);
  expect(await count()).toEqual({ count: 100, capped: false });
  expect((await flags()).filter((item) => !item.unread).map((item) => item.id)).toEqual([
    ids[1]!,
    ids[0]!,
    ids[102]!,
    delayed,
  ]);
  await db.admin.query('DELETE FROM content.notice_seen WHERE route=$1 AND account_id=$2', [r, fixture.accountId]);
  db.pool.options.max = 4;
  try {
    expect((await Promise.all([mark(ids[2]!), mark(ids[1]!)])).map((result) => result.response.status)).toEqual([
      204, 204,
    ]);
    expect(await count()).toEqual({ count: 99, capped: false });
  } finally {
    db.pool.options.max = 1;
  }
});

test('native inbox keeps readable public notices, hides a revoked protected notice, and omits a notice denied before send', async () => {
  const driver = await createContentNotificationDriver();
  try {
    const people = await driver.provision();
    let serial = 0;
    const makeThread = async (boardId: string, label: string) => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const created = await driver.createThread(
          {
            boardId,
            visibility: 'published',
            body: {
              version: 'rezics-document-v1',
              profile: 'text',
              doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: label }] }] },
            },
          },
          { actor: people.author, key: JSON.stringify(`inbox-${label}-${serial++}`) },
        );
        expect(created.response.status).toBe(201);
        if (routeOf(created.value!.id) !== routeOf(boardId)) return created.value!;
      }
      throw new Error(`Could not obtain an independently routed ${label} thread`);
    };
    const reply = async (threadId: string, parentId: string, label: string) => {
      const created = await driver.createPost(
        {
          threadId,
          parentId,
          visibility: 'published',
          body: {
            version: 'rezics-document-v1',
            profile: 'text',
            doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: label }] }] },
          },
        },
        { actor: people.replier, key: JSON.stringify(`inbox-${label}-${serial++}`) },
      );
      expect(created.response.status).toBe(201);
      return created.value!;
    };

    const publicThread = await makeThread(people.publicBoardId, 'public');
    const publicReply = await reply(publicThread.id, publicThread.firstPost.id, 'public reply');
    const writtenThread = await makeThread(people.protectedBoardId, 'written-before-revocation');
    const writtenReply = await reply(writtenThread.id, writtenThread.firstPost.id, 'protected reply');
    await driver.effects('drain');

    const deniedThread = await makeThread(people.protectedBoardId, 'revoked-before-send');
    const deniedReply = await reply(deniedThread.id, deniedThread.firstPost.id, 'refused reply');
    await driver.fixtures.realmMember(people.author, false);
    await driver.effects('drain');

    const revokedInbox = await driver.inbox(people.author.id, people.author, { limit: 50 });
    expect(revokedInbox.response.status).toBe(200);
    const revokedPosts = revokedInbox.value!.items.map((notice) => notice.target.postId);
    expect(revokedPosts).toContain(publicReply.id);
    expect(revokedPosts).not.toContain(writtenReply.id);
    expect(revokedPosts).not.toContain(deniedReply.id);

    await driver.fixtures.realmMember(people.author, true);
    const restoredInbox = await driver.inbox(people.author.id, people.author, { limit: 50 });
    expect(restoredInbox.response.status).toBe(200);
    const restoredPosts = restoredInbox.value!.items.map((notice) => notice.target.postId);
    expect(restoredPosts).toContain(publicReply.id);
    expect(restoredPosts).toContain(writtenReply.id);
    expect(restoredPosts).not.toContain(deniedReply.id);
    const restoredItems = restoredInbox.value!.items as unknown as Array<{
      id: string;
      currentActor: { state: string; accountId?: string; displayName: string; avatarUrl: string | null };
      currentTarget: {
        state: string;
        threadId: string | null;
        postId: string | null;
        boardId: string | null;
        threadTitle: string | null;
        boardTitle: string | null;
      };
      summary: string;
      actions: {
        open: { kind: string; threadId?: string; postId?: string } | null;
        markSeen: { method: string; path: string };
      };
    }>;
    const publicNotice = restoredItems.find((item) => item.target.postId === publicReply.id)!;
    expect(publicNotice.currentActor).toMatchObject({ state: 'available', accountId: people.replier.id });
    expect(publicNotice.currentActor.displayName.length).toBeGreaterThan(0);
    expect(publicNotice.currentTarget).toMatchObject({
      state: 'available',
      threadId: publicThread.id,
      postId: publicReply.id,
      boardId: people.publicBoardId,
      threadTitle: 'Notification test thread',
    });
    expect(publicNotice.currentTarget.boardTitle).toEqual(expect.any(String));
    expect(publicNotice.summary).toEqual(expect.any(String));
    expect(publicNotice.actions.open).toEqual({ kind: 'thread_post', threadId: publicThread.id, postId: publicReply.id });
    expect(publicNotice.actions.markSeen).toMatchObject({
      method: 'POST',
      path: `/v1/accounts/${people.author.id}/notifications/${publicNotice.id}:markSeen`,
    });
  } finally {
    await driver.close();
  }
}, 60_000);

test('a reporter keeps the current outcome action when the reported target is withheld', async () => {
  const driver = await createContentNotificationDriver();
  try {
    const people = await driver.provision();
    const thread = await driver.createThread(
      {
        boardId: people.publicBoardId,
        visibility: 'published',
        body: {
          version: 'rezics-document-v1',
          profile: 'text',
          doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'reported' }] }] },
        },
      },
      { actor: people.author, key: JSON.stringify('report-notice-thread') },
    );
    expect(thread.response.status).toBe(201);
    const post = await driver.createPost(
      {
        threadId: thread.value!.id,
        parentId: thread.value!.firstPost.id,
        visibility: 'published',
        body: {
          version: 'rezics-document-v1',
          profile: 'text',
          doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'reported reply' }] }] },
        },
      },
      { actor: people.replier, key: JSON.stringify('report-notice-post') },
    );
    expect(post.response.status).toBe(201);
    const report = await driver.report(
      { kind: 'post', id: post.value!.id },
      { actor: people.reporter, key: JSON.stringify('report-notice-report') },
    );
    expect(report.response.status).toBe(201);
    const removed = await driver.takedown(
      { kind: 'post', id: post.value!.id },
      'Action on reported content',
      { actor: people.moderator, key: JSON.stringify('report-notice-takedown') },
    );
    expect(removed.response.status).toBe(200);
    await driver.effects('drain');

    const inbox = await driver.inbox(people.reporter.id, people.reporter, { limit: 50 });
    expect(inbox.response.status).toBe(200);
    const item = (inbox.value!.items as unknown as Array<{
      target: { reportId?: string };
      currentTarget: { state: string };
      summary: string;
      actions: { open: unknown };
    }>).find((notice) => notice.target.reportId === report.value!.reportId);
    expect(item).toMatchObject({
      currentTarget: { state: 'withheld' },
      summary: 'your report was actioned',
      actions: { open: { kind: 'report_outcome', reportId: report.value!.reportId } },
    });
  } finally {
    await driver.close();
  }
}, 60_000);
