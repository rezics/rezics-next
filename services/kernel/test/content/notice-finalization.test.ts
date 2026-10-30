import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { finalizeOptionalNotice } from '../../src/content/notices.ts';
import { createReplyNoticeEffect } from '../../src/content/reply-notices.ts';
import { postReadableByAccount } from '../../src/content/reads.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createContentNotificationDriver } from './notification-driver.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';

const mentions = (...accounts: string[]) => ({
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: accounts.map((accountId) => ({
          type: 'mention',
          attrs: { accountId },
        })),
      },
    ],
  },
});

test('a published opening delivers mentions once and required outcomes survive optional toggles', async () => {
  const driver = await createContentNotificationDriver();
  try {
    const people = await driver.provision();
    const created = await driver.createThread(
      {
        boardId: people.publicBoardId,
        visibility: 'published',
        body: mentions(people.mentioned.id, people.mentioned.id, people.author.id),
      },
      { actor: people.author, key: JSON.stringify(randomUUID()) },
    );
    expect(created.response.status).toBe(201);
    const thread = created.value!;
    await driver.effects('drain');
    const inbox = () => driver.inbox(people.mentioned.id, people.mentioned);
    expect((await inbox()).value!.items).toEqual([
      expect.objectContaining({
        kind: 'mention',
        target: { threadId: thread.id, postId: thread.firstPost.id },
      }),
    ]);
    expect((await driver.inbox(people.author.id, people.author)).value!.items).toEqual([]);
    await driver.effects('replay');
    expect((await inbox()).value!.items).toHaveLength(1);
    for (const kind of ['reply', 'mention'] as const)
      await driver.fixtures.notificationAllowed(people.author, kind, false);
    expect(
      (
        await driver.takedown({ kind: 'post', id: thread.firstPost.id }, 'Required outcome', {
          actor: people.moderator,
          key: JSON.stringify(randomUUID()),
        })
      ).response.status,
    ).toBe(200);
    await driver.effects('drain');
    expect((await driver.inbox(people.author.id, people.author)).value!.items).toContainEqual(
      expect.objectContaining({ kind: 'moderation_decision' }),
    );
  } finally {
    await driver.close();
  }
}, 120_000);

test('current recipient preference or eligibility before commit suppresses permanently across effect redrive', async () => {
  const f = await replyNoticeFixture();
  try {
    const recipient = f.accounts.recipient;
    const route = routeOf(recipient)!;
    for (const denial of ['preference', 'account'] as const) {
      const thread = await f.thread();
      const post = await f.post(thread.id);
      const event = (await f.envelope(post.id)).events.find(Boolean)!;
      const deadline = Date.now() + 30_000;
      const readable = await postReadableByAccount(
        { pool: f.db.pool, access: f.accounts.access },
        recipient,
        thread.id,
        post.id,
        { deadline },
      );
      expect(readable).toBe(true);
      if (denial === 'preference') {
        expect(
          (
            await f.call(recipient, 'PATCH', `/v1/accounts/${recipient}/preferences`, {
              expectedVersion: 0,
              notifications: { reply: false },
            })
          ).status,
        ).toBe(200);
      } else {
        await f.db.admin.query("UPDATE access.account SET state='pending' WHERE route=$1 AND account_id=$2", [
          route,
          recipient,
        ]);
      }
      await finalizeOptionalNotice(
        f.db.pool,
        {
          recipientId: recipient,
          noticeId: newId(route),
          kind: 'reply',
          actorId: f.accounts.actor,
          threadId: thread.id,
          postId: post.id,
          sourceId: post.id,
          decisionId: null,
          reportId: null,
          createdAt: new Date(event.time),
        },
        readable,
        deadline,
      );
      expect(await f.notices(post.id)).toEqual([]);
      await f.db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
        route,
        recipient,
      ]);
      await f.db.admin.query('DELETE FROM access.account_preferences WHERE route=$1 AND account_id=$2', [
        route,
        recipient,
      ]);
      // Run the real effect again, including the crash window before DBOS records
      // success: the already committed recipient refusal must still win.
      await createReplyNoticeEffect(f.db.pool, f.accounts.access).run(event);
      expect(await f.notices(post.id)).toEqual([]);
    }
  } finally {
    await f.close();
  }
}, 120_000);
