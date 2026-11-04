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

function textBody(text: string) {
  return {
    version: 'rezics-document-v1',
    profile: 'text',
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  };
}

function mentionBody(accountId: string) {
  return {
    version: 'rezics-document-v1',
    profile: 'text',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'notice-mention' },
          content: [{ type: 'mention', attrs: { accountId } }],
        },
      ],
    },
  };
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

test('mounted list and exact notice independently admit native actor avatars and the original target', async () => {
  await seed(0);
  const target = await fixture.target();
  for (const [id, action] of [
    [target.board, 'board:read'],
    [target.thread, 'thread:read'],
    [target.post, 'post:read'],
  ])
    await fixture.grant(id!, [action!]);
  const actor = fixture.managerId;
  const actorRoute = routeOf(actor)!;
  const media = newId(actorRoute);
  await db.admin.query(
    `INSERT INTO content.media
      (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,
       byte_count,actual_byte_count,sha256,state,key,transaction_id,width,height,thumbhash,average_color)
     VALUES ($1,$2,$3,$3,$2::text,'avatar','image/png',256,256,repeat('a',64),'available',
             'unused-original-key',$2,64,64,decode('010203','hex'),'#123456')`,
    [actorRoute, media, actor],
  );
  await db.admin.query('UPDATE access.account SET avatar=$3 WHERE route=$1 AND account_id=$2', [
    actorRoute,
    actor,
    media,
  ]);
  const base = `/v1/accounts/${fixture.accountId}/notifications`;
  const ids = Array.from({ length: 4 }, () => newId(routeOf(fixture.accountId)!));
  await db.admin.query(
    `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,actor_id,thread_id,post_id,created_at)
     SELECT $1,$2,id,kind,$4,$5,$6,$4,now()+ordinality*interval '1 second'
     FROM unnest($3::uuid[],ARRAY['reply','mention','thread_watch','board_activity']) WITH ORDINALITY AS n(id,kind,ordinality)`,
    [routeOf(fixture.accountId), fixture.accountId, ids, target.post, actor, target.thread],
  );
  try {
    const page = await call(`${base}?limit=4`);
    expect(page.response.status).toBe(200);
    expect(page.value.items.map((item: { id: string }) => item.id)).toEqual([...ids].reverse());
    const expected = {
      actor: { state: 'available', accountId: actor, avatar: { media, width: 64, height: 64 }, avatarUrl: null },
      target: { state: 'available', threadId: target.thread, postId: target.post, boardId: target.board },
      actions: { open: { kind: 'thread_post', threadId: target.thread, postId: target.post } },
      unread: true,
    };
    for (const item of page.value.items) expect(item).toMatchObject(expected);
    const exact = await call(`${base}/${ids[0]}`);
    expect(exact.response.status).toBe(200);
    expect(exact.value).toMatchObject({ viewer: { state: 'current' }, notice: expected });
    await db.admin.query('UPDATE content.media SET taken_down=true WHERE route=$1 AND media_id=$2', [
      actorRoute,
      media,
    ]);
    expect((await call(`${base}/${ids[0]}`)).value.notice).toMatchObject({
      ...expected,
      actor: { state: 'available', avatar: null },
    });
    await db.admin.query("UPDATE access.account SET state='pending' WHERE route=$1 AND account_id=$2", [
      actorRoute,
      actor,
    ]);
    expect((await call(`${base}/${ids[0]}`)).value.notice).toMatchObject({
      ...expected,
      actorId: null,
      actor: { state: 'withheld', displayName: 'Former or unavailable account', avatar: null },
    });
  } finally {
    await db.admin.query("UPDATE access.account SET state='active',avatar=NULL WHERE route=$1 AND account_id=$2", [
      actorRoute,
      actor,
    ]);
  }
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
    await db.admin.query(
      'SELECT count(*)::integer AS count FROM content.notice_seen WHERE route=$1 AND account_id=$2',
      [routeOf(fixture.accountId), fixture.accountId],
    ),
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
    const publicNotice = restoredItems.find((item) => item.currentTarget.postId === publicReply.id)!;
    expect(publicNotice.currentActor).toMatchObject({
      state: 'available',
      accountId: people.replier.id,
      avatar: null,
      avatarUrl: null,
    });
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
    expect(publicNotice.actions.open).toEqual({
      kind: 'thread_post',
      threadId: publicThread.id,
      postId: publicReply.id,
    });
    expect(publicNotice.actions.markSeen).toMatchObject({
      method: 'POST',
      path: `/v1/accounts/${people.author.id}/notifications/${publicNotice.id}:markSeen`,
    });

    const exact = await driver.readNotice(people.author.id, publicNotice.id, people.author);
    expect(exact.response.status).toBe(200);
    expect(exact.response.headers.get('cache-control')).toContain('no-store');
    expect(exact.value).toMatchObject({
      viewer: { state: 'current' },
      notice: {
        id: publicNotice.id,
        unread: true,
        currentActor: { state: 'available', accountId: people.replier.id, avatar: null, avatarUrl: null },
        currentTarget: { state: 'available', threadId: publicThread.id, postId: publicReply.id },
        actions: { open: { kind: 'thread_post', threadId: publicThread.id, postId: publicReply.id } },
      },
    });
    const stillUnread = await driver.inbox(people.author.id, people.author, { limit: 50 });
    expect(stillUnread.value?.items.find((item) => item.id === publicNotice.id)?.unread).toBe(true);
    const foreign = await driver.readNotice(people.author.id, publicNotice.id, people.replier);
    expect(foreign.response.status).toBe(404);
    expect(foreign.value).toBeNull();
    const unknown = await driver.readNotice(people.author.id, newId(routeOf(people.author.id)!), people.author);
    expect(unknown.response.status).toBe(404);
    expect(unknown.value).toBeNull();
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
    const removed = await driver.takedown({ kind: 'post', id: post.value!.id }, 'Action on reported content', {
      actor: people.moderator,
      key: JSON.stringify('report-notice-takedown'),
    });
    expect(removed.response.status).toBe(200);
    await driver.effects('drain');

    const inbox = await driver.inbox(people.reporter.id, people.reporter, { limit: 50 });
    expect(inbox.response.status).toBe(200);
    const item = (
      inbox.value!.items as unknown as Array<{
        target: { reportId?: string };
        currentTarget: { state: string };
        summary: string;
        actions: { open: unknown };
      }>
    ).find((notice) => notice.target.reportId === report.value!.reportId);
    expect(item).toMatchObject({
      currentTarget: { state: 'withheld' },
      summary: 'your report was actioned',
      actions: { open: { kind: 'report_outcome', reportId: report.value!.reportId } },
    });
    const exact = await driver.readReport(report.value!.reportId, people.reporter);
    expect(exact.response.status).toBe(200);
    expect(exact.value).toMatchObject({ id: report.value!.reportId, outcome: 'actioned' });
  } finally {
    await driver.close();
  }
}, 60_000);

test('the final Inbox pass omits a revoked ordinary target but retains the reporter outcome and exact read', async () => {
  const driver = await createContentNotificationDriver();
  try {
    const people = await driver.provision();
    const thread = await driver.createThread(
      { boardId: people.protectedBoardId, visibility: 'published', body: mentionBody(people.reporter.id) },
      { actor: people.author, key: JSON.stringify('hydration-report-mention') },
    );
    expect(thread.response.status).toBe(201);
    const report = await driver.report(
      { kind: 'post', id: thread.value!.firstPost.id },
      { actor: people.reporter, key: JSON.stringify('hydration-report') },
    );
    expect(report.response.status).toBe(201);
    const dismissed = await driver.dismissReport(report.value!.reportId, 'No action is warranted', {
      actor: people.moderator,
      key: JSON.stringify('hydration-report-dismiss'),
    });
    expect(dismissed.response.ok).toBe(true);
    await driver.effects('drain');

    const inbox = await driver.inboxDuringActorHydration(people.reporter.id, people.reporter, { limit: 20 }, () =>
      driver.fixtures.realmMember(people.reporter, false),
    );
    expect(inbox.response.status).toBe(200);
    const items = inbox.value!.items as unknown as Array<{
      kind: string;
      target: { reportId?: string };
      currentTarget: { state: string };
      summary: string;
      actions: { open: unknown };
    }>;
    expect(items.filter((item) => item.kind === 'mention')).toHaveLength(0);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      target: { reportId: report.value!.reportId },
      currentTarget: { state: 'withheld' },
      summary: 'your report was dismissed',
      actions: { open: { kind: 'report_outcome', reportId: report.value!.reportId } },
    });
    const exact = await driver.readReport(report.value!.reportId, people.reporter);
    expect(exact.response.status).toBe(200);
    expect(exact.value).toMatchObject({ id: report.value!.reportId, outcome: 'dismissed' });
  } finally {
    await driver.close();
  }
}, 60_000);

test('actor erasure and a changed author decision are finished after actor hydration', async () => {
  const driver = await createContentNotificationDriver();
  try {
    const people = await driver.provision();
    const publicThread = await driver.createThread(
      { boardId: people.publicBoardId, visibility: 'published', body: textBody('Readable reply source') },
      { actor: people.author, key: JSON.stringify('hydration-public-source') },
    );
    expect(publicThread.response.status).toBe(201);
    const reply = await driver.createPost(
      {
        threadId: publicThread.value!.id,
        parentId: publicThread.value!.firstPost.id,
        visibility: 'published',
        body: textBody('Reply from an actor who will be erased'),
      },
      { actor: people.replier, key: JSON.stringify('hydration-reply') },
    );
    expect(reply.response.status).toBe(201);
    const affected = await driver.createThread(
      { boardId: people.publicBoardId, visibility: 'published', body: textBody('Decision source') },
      { actor: people.author, key: JSON.stringify('hydration-decision-source') },
    );
    expect(affected.response.status).toBe(201);
    expect(
      (
        await driver.takedown({ kind: 'thread', id: affected.value!.id }, 'Decision statement', {
          actor: people.moderator,
          key: JSON.stringify('hydration-decision'),
        })
      ).response.ok,
    ).toBe(true);
    await driver.effects('drain');

    const original = await driver.inbox(people.author.id, people.author, { limit: 20 });
    expect(original.response.status).toBe(200);
    const decisionNotice = original.value!.items.find((item) => item.kind === 'moderation_decision');
    const decisionId = decisionNotice?.target.decisionId;
    expect(decisionId).toEqual(expect.any(String));
    const appeal = await driver.appeal(decisionId!, 'Please restore the post', {
      actor: people.author,
      key: JSON.stringify('hydration-appeal'),
    });
    expect(appeal.response.status).toBe(201);

    let resolution: Awaited<ReturnType<typeof driver.resolveAppeal>> | undefined;
    const current = await driver.inboxDuringActorHydration(people.author.id, people.author, { limit: 20 }, async () => {
      resolution = await driver.resolveAppeal(appeal.value!.id, 'reverse', 'The removal was mistaken', {
        actor: people.moderator,
        key: JSON.stringify('hydration-appeal-resolution'),
      });
      await driver.fixtures.accountState(people.replier, 'deleted');
    });
    expect(current.response.status).toBe(200);
    expect(resolution?.response.status).toBe(200);
    expect(resolution?.value).toMatchObject({ outcome: 'reverse' });
    expect(current.value!.items).toHaveLength(2);
    const items = current.value!.items as unknown as Array<{
      kind: string;
      target: { postId?: string; decisionId?: string };
      currentActor: { state: string; displayName: string };
      actions: { open: { kind: string; decisionId?: string } | null };
    }>;
    const replyNotice = items.find((item) => item.kind === 'reply')!;
    expect(replyNotice).toMatchObject({
      kind: 'reply',
      target: { postId: reply.value!.id },
      currentActor: { state: 'withheld', displayName: 'Former or unavailable account' },
    });
    expect(items.find((item) => item.target.decisionId === decisionId)).toMatchObject({
      actions: { open: { kind: 'moderation_decision', decisionId } },
    });
    const exact = await driver.decision(decisionId!, people.author);
    expect(exact.response.status).toBe(200);

    await driver.effects('drain');
    const resolvedInbox = await driver.inbox(people.author.id, people.author, { limit: 20 });
    expect(resolvedInbox.response.status).toBe(200);
    expect(
      (resolvedInbox.value!.items as unknown as Array<{ summary: string; actions: { open: unknown } }>).find(
        (item) => item.summary === 'your appeal restored the content',
      ),
    ).toMatchObject({ actions: { open: { kind: 'moderation_decision', decisionId } } });
  } finally {
    await driver.close();
  }
}, 60_000);
