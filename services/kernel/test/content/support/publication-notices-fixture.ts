import { expect } from 'bun:test';
import { normalizeDocument } from '@rezics/document';
import type { Persona } from '../../../../../specs/content-notification-driver.ts';
import { createNotificationFixture } from './notification-fixtures.ts';
import { createNotificationEffectHost } from './notification-effect-host.ts';

type Post = { id: string; revisionId: string; visibility: string };
type Thread = { id: string; firstPost: Post };
export const mentions = (...accounts: Persona[]) => normalizeDocument({
  version: 'rezics-document-v1', profile: 'text',
  doc: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'publication' },
    content: accounts.map(({ id }) => ({ type: 'mention', attrs: { accountId: id } })),
  }] },
});

/** Private composition: native Auth/authoring plus the registered production
 * relay host. No authoring adapter or notice effect is replaced. */
export async function publicationNoticesFixture() {
  const setup = await createNotificationFixture();
  let host: Awaited<ReturnType<typeof createNotificationEffectHost>>;
  try {
    host = await createNotificationEffectHost(setup.appDatabaseUrl, setup.workClock);
  } catch (error) {
    await setup.close();
    throw error;
  }
  const people = setup.fixture;
  const consumer = `publication-notices-${crypto.randomUUID()}`;
  async function call<T>(actor: Persona, method: string, path: string, body?: unknown,
    options: { head?: string; key?: string; status?: number } = {}) {
    const response = await setup.system.kernel.handle(new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${actor.bearer}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(options.key ?? crypto.randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.head === undefined ? {} : { 'if-match': JSON.stringify(options.head) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(options.status ?? (method === 'POST' ? 201 : 200));
    return value as T;
  }
  return {
    setup, people, call,
    async thread(accounts: Persona[] = [], visibility = 'published', boardId = people.publicBoardId) {
      const { thread } = await call<{ thread: Thread }>(people.author, 'POST', '/v1/threads', {
        title: 'Publication notices', body: mentions(...accounts), licence: 'MIT', subjectIds: [], boardId, visibility,
      });
      setup.remember(thread.id);
      for (const actor of [people.author, people.replier, people.mentioned])
        await setup.grantPostTarget(thread.id, actor.id);
      return thread;
    },
    async reply(thread: Thread, accounts: Persona[], visibility = 'published', parentId?: string) {
      const { post } = await call<{ post: Post }>(people.replier, 'POST', `/v1/threads/${thread.id}/posts`, {
        body: mentions(...accounts), licence: 'MIT', visibility,
        ...(parentId === undefined ? {} : { parentId }),
      });
      setup.remember(post.id);
      return post;
    },
    async revise(post: Post, accounts: Persona[], visibility?: string,
      actor = people.replier, key = crypto.randomUUID()) {
      return (await call<{ post: Post }>(actor, 'POST', `/v1/posts/${post.id}/revisions`, {
        body: mentions(...accounts), ...(visibility === undefined ? {} : { visibility }),
      }, { head: post.revisionId, key, status: 200 })).post;
    },
    async notices(post: Post) {
      // Observe stored outcomes too: a hidden inbox item must not mask a bad send.
      return (await setup.system.database.pool.query(
        'SELECT recipient_id::text,kind FROM content.notice WHERE post_id=$1 ORDER BY recipient_id,kind', [post.id],
      )).rows as { recipient_id: string; kind: string }[];
    },
    async inbox(actor: Persona, post: Post) {
      const inbox = await call<{ items: { kind: string; postId?: string }[] }>(
        actor, 'GET', `/v1/accounts/${actor.id}/notifications?limit=50`,
      );
      return inbox.items.filter((item) => item.postId === post.id);
    },
    async deliver(replay = false) {
      await host.deliver(replay ? `${consumer}-replay-${crypto.randomUUID()}` : consumer, [...setup.contentPartitions]);
    },
    async takeDown(post: Post, thread: Thread) {
      await setup.grantModerationTarget(post.id, thread.id);
      await call(people.moderator, 'POST', `/v1/posts/${post.id}:takeDown`,
        { reason: 'Ancestor no longer readable' }, { status: 200 });
    },
    async close() {
      try { await host.close(); } finally { await setup.close(); }
    },
  };
}
