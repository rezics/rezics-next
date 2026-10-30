import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import { documentText, fromPlainText } from '@rezics/document';
import { loadThreadPageWithAuthors } from '../src/identity/page-loaders';
import { ReplyIntent } from '../src/threads/reply-context-intent';
import { replyToThreadRequest } from '../src/threads/reply-context-request';
import type { CreatedPost } from '../src/threads/actions';
import type { ThreadReadingPage, ThreadReadingPersonal } from '../src/threads/thread-reading';
import thread from '../src/kernel/recorded/thread.json';
import posts from '../src/kernel/recorded/thread-posts.json';
import board from '../src/kernel/recorded/board.json';
import accounts from '../src/kernel/recorded/accounts.json';
import realm from '../src/kernel/recorded/board-realm-realm.json';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { ThreadReading } = await import('../src/threads/thread-reading');
const { ThreadReadingHeader, ThreadReadingPost } = await import('../src/routes/threads/$id_.$slug');

async function readingPage(): Promise<ThreadReadingPage> {
  const client = createKernelClient('https://kernel.test', { fetch: async (input, init) => {
    const path = new URL(new Request(input, init).url).pathname;
    if (path.endsWith('/posts')) return Response.json(posts);
    if (path.includes('/boards/')) return Response.json(board);
    if (path.endsWith('/accounts')) return Response.json(accounts);
    return Response.json(thread);
  } });
  const page = await loadThreadPageWithAuthors(client, new Request('https://rezics.test/'), {},
    { id: thread.thread.id }, { sitekey: '', scriptUrl: '' }, 'anonymous');
  return { ...page, provenanceSubjects: page.subjects };
}
async function render(page: ThreadReadingPage, personal?: ThreadReadingPersonal) {
  const region = createElement(ThreadReading, {
    page, personal, Post: ThreadReadingPost, session: personal ? 'signed-in' : 'signed-out',
    returnTo: '/', signedOut: 'Sign in to reply',
    renderHeader: (title) => createElement(ThreadReadingHeader, { page, title }),
    onMutation: async () => {}, onPageRefresh: async () => page,
  });
  const route = createRootRoute({ component: () => region });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }), ssr: {} });
  await router.load();
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

test('the real reading region renders current documents, honest community context and lifecycle slots at a readable measure', async () => {
  const page = await readingPage();
  const html = await render(page);
  expect(html).toContain('data-slot="thread-reading"');
  expect(html).toContain(page.thread.title!);
  expect(html).toContain('Mira Okabe');
  expect(html).toContain('max-w-[65ch]');
  expect(html).toContain(m.thread_reading_share());
  expect(html).toContain(m.thread_history_show());
  expect(html).toContain(m.report_more());
  expect(html).not.toContain('thread-community-heading');
  expect(html).not.toContain('min-h-[22rem]');
  for (const post of page.posts.posts) expect(html).toContain(`id="post-${post.id}"`);
  const lifecycle: ThreadReadingPage = { ...page,
    realm: { id: realm.realm.realmId, title: realm.realm.title, summary: realm.realm.summary },
    posts: { ...page.posts, posts: page.posts.posts.map((post, index) => index === 0 ? post : {
      ...post, body: null, sha256: null, removed: true,
      availability: index === 1 ? 'erased' : 'withheld',
    }) },
  };
  const removed = await render(lifecycle);
  expect(removed).toContain(realm.realm.summary);
  expect(removed).toContain('lg:grid-cols-');
  expect(removed).toContain(m.thread_post_deleted());
  expect(removed).toContain(m.thread_post_withheld());
  expect(removed).toContain(m.thread_reply_parent_deleted());
  for (const post of page.posts.posts.slice(1)) {
    if (post.availability === 'available') expect(removed).not.toContain(documentText(post.body));
  }
  const empty = await render({ ...page, posts: { ...page.posts, posts: [], next: 'signed-continuation' } });
  expect(empty).toContain(m.thread_reading_empty_page());
  expect(empty).toContain('cursor=signed-continuation');
  expect(empty).not.toContain(m.thread_posts_empty());
});

test('a selected reply keeps its native intent on retry and the returned relationship reaches the real reading region after current refusals', async () => {
  const page = await readingPage();
  const parent = page.posts.posts[0]!;
  if (parent.availability !== 'available') throw new Error('The recorded parent must be readable');
  const created: CreatedPost = { ...parent, id: '0192f3a0-6c1e-7b2a-9d4e-000000000090',
    parentId: parent.id, body: fromPlainText('A reply returned by the command.', 'blocks') };
  const intent = new ReplyIntent('0192f3a0-6c1e-7b2a-9d4e-000000000091');
  const draft = { title: '', body: created.body, mediaIds: [] };
  const command = intent.prepare(draft, parent.id);
  const calls: { key: string | null; body: string }[] = [];
  let denied = false;
  const client = createKernelClient('https://kernel.test', { fetch: async (input, init) => {
    const request = new Request(input, init);
    calls.push({ key: request.headers.get('idempotency-key'), body: await request.text() });
    expect(request.headers.get('authorization')).toBe('Bearer current-viewer');
    if (denied) return Response.json({ code: 'forbidden' }, { status: 403 });
    if (calls.length === 1) throw new Error('Response lost');
    return Response.json({ post: created }, { status: 201 });
  } });
  const send = () => replyToThreadRequest({ ...intent.prepare(draft, parent.id), threadId: page.thread.id },
    client, 'Bearer current-viewer', () => ({ ok: false, reason: 'forbidden' }));
  expect(await send()).toEqual({ ok: false, reason: 'unavailable' });
  const result = await send();
  expect(calls[1]).toEqual(calls[0]);
  expect(JSON.parse(calls[0]!.body).parentId).toBe(parent.id);
  expect(result).toEqual({ ok: true, post: created });
  denied = true;
  expect(await send()).toEqual({ ok: false, reason: 'forbidden' });
  expect(calls[2]).toEqual(calls[0]);
  expect(intent.prepare(draft, null).idempotencyKey).not.toBe(command.idempotencyKey);
  if (!result.ok) throw new Error('A successful command must return the post');
  const html = await render({ ...page, posts: { ...page.posts, posts: [...page.posts.posts, result.post] } }, {
    viewerId: parent.authorId, reactions: {}, reviewVotes: {}, idempotencyKey: command.idempotencyKey,
  });
  expect(html).toContain(`id="post-${created.id}"`);
  expect(html).toContain(`href="#post-${parent.id}"`);
  expect(html).toContain('A reply returned by the command.');
  expect(html.match(/name="idempotency_key"/g)).toHaveLength(1);
  expect(html).toContain(m.thread_reply_to_post());
});
