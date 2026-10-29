import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { createReplyNoticeEffect } from '../../src/content/reply-notices.ts';
import { effectWorkflowId, launchWork, registerEffects, shutdownWork } from '../../src/events/effects.ts';
import { routeOf } from '../../src/route/route.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';

let f: Awaited<ReturnType<typeof replyNoticeFixture>>;
let effects: ReturnType<typeof registerEffects>;
beforeAll(async () => {
  f = await replyNoticeFixture();
  effects = registerEffects([createReplyNoticeEffect(f.db.pool, f.accounts.access)], f.db.pool);
  await launchWork({ databaseUrl: process.env.DATABASE_URL!, systemDatabasePool: f.db.pool });
});
afterAll(async () => { await shutdownWork(); await f?.close(); });
async function deliver(postId: string) {
  const envelope = await f.envelope(postId);
  await effects.enqueue([envelope]);
  const index = envelope.events.findIndex(Boolean);
  await DBOS.retrieveWorkflow(effectWorkflowId(envelope, index, 'content_reply_notice')).getResult();
}

test("a reply notifies the parent post's author and a top-level post notifies the thread's author, once each, never the actor", async () => {
  const thread = await f.thread();
  const top = await f.post(thread.id);
  const parent = await f.post(thread.id, f.accounts.principal);
  const reply = await f.post(thread.id, f.accounts.actor, parent.id);
  const self = await f.post(thread.id, f.accounts.recipient);
  for (const post of [top, reply, self]) await deliver(post.id);
  expect(await f.notices(top.id)).toEqual([{
    recipient_id: f.accounts.recipient, kind: 'reply', actor_id: f.accounts.actor,
    thread_id: thread.id, post_id: top.id, source_id: top.id,
  }]);
  expect((await f.notices(reply.id)).map(row => row.recipient_id)).toEqual([f.accounts.principal]);
  expect(await f.notices(self.id)).toEqual([]);
  // Opening-post events, when present, cannot notify their own actor.
  const opening = await f.db.admin.query("SELECT 1 FROM core.outbox WHERE type='com.rezics.content.post.created.v1' AND data->>'itemId'=$1", [thread.firstPost.id]);
  if (opening.rowCount) { await deliver(thread.firstPost.id); expect(await f.notices(thread.firstPost.id)).toEqual([]); }
}, 60_000);

test('a recipient who cannot read the post at send time, who turned replies off, or who is deleted receives nothing', async () => {
  const controlThread = await f.thread();
  const control = await f.post(controlThread.id);
  await deliver(control.id);
  expect(await f.notices(control.id)).toHaveLength(1);
  for (const denial of ['board', 'thread', 'ancestor', 'post', 'preference', 'suspended', 'fenced', 'deleted', 'draft'] as const) {
    const thread = await f.thread();
    const parent = await f.post(thread.id, f.accounts.recipient);
    const post = await f.post(thread.id, f.accounts.actor, parent.id);
    const recipient = f.accounts.recipient;
    const target = denial === 'board' ? f.boardId : denial === 'thread' ? thread.id : denial === 'ancestor' ? parent.id : post.id;
    const action = denial === 'board' ? 'board:read' : denial === 'thread' ? 'thread:read' : 'post:read';
    // Prove the recipient could read before the send-time change.
    expect((await f.call(recipient, 'GET', `/v1/posts/${post.id}`)).status).toBe(200);
    if (['board', 'thread', 'ancestor', 'post'].includes(denial)) {
      await f.db.admin.query(
        `INSERT INTO access.resource_denial (route,resource_id,subject_id,action,reason,valid,transaction_id)
         VALUES ($1,$2,$3,$4,'resource','(,)',$3)`, [routeOf(target), target, recipient, action],
      );
    } else if (denial === 'preference') {
      const result = await f.call(recipient, 'PATCH', `/v1/accounts/${recipient}/preferences`, { expectedVersion: 0, notifications: { reply: false } });
      expect(result.status).toBe(200);
    } else if (denial === 'draft') {
      await f.db.admin.query("UPDATE content.thread SET visibility='draft' WHERE route=$1 AND thread_id=$2", [routeOf(thread.id), thread.id]);
    } else {
      await f.db.admin.query(`UPDATE access.account SET state=$3,authn_fenced=$4 WHERE route=$1 AND account_id=$2`,
        [routeOf(recipient), recipient, denial === 'fenced' ? 'active' : denial, denial === 'fenced']);
    }
    await deliver(post.id);
    expect(await f.notices(post.id)).toEqual([]);
    // Restore the fixture, then replay: a completed negative outcome stays negative.
    await f.db.admin.query('DELETE FROM access.resource_denial WHERE resource_id=$1 AND subject_id=$2', [target, recipient]);
    await f.db.admin.query("UPDATE access.account SET state='active',authn_fenced=false WHERE route=$1 AND account_id=$2", [routeOf(recipient), recipient]);
    await f.db.admin.query('DELETE FROM access.account_preferences WHERE route=$1 AND account_id=$2', [routeOf(recipient), recipient]);
    await f.db.admin.query("UPDATE content.thread SET visibility='published' WHERE route=$1 AND thread_id=$2", [routeOf(thread.id), thread.id]);
    await deliver(post.id);
    expect(await f.notices(post.id)).toEqual([]);
  }
}, 120_000);

test('replayed post events add no second notice', async () => {
  const thread = await f.thread();
  const post = await f.post(thread.id);
  await deliver(post.id);
  expect(await f.notices(post.id)).toHaveLength(1);
  await deliver(post.id);
  expect(await f.notices(post.id)).toHaveLength(1);
  // A second effect invocation still reaches the store's unique source constraint.
  const envelope = await f.envelope(post.id);
  await createReplyNoticeEffect(f.db.pool, f.accounts.access).run(envelope.events.find(Boolean)!);
  expect(await f.notices(post.id)).toHaveLength(1);
}, 60_000);
