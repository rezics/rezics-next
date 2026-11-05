import { authoredReadingPage } from '../src/kernel/fake/thread-reading-page';
import type { ReadingPage } from '../src/threads/thread-page';
import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import { documentText, fromPlainText } from '@rezics/document';
import { loadThreadPageWithAuthors } from '../src/identity/page-loaders';
import { ReplyIntent } from '../src/threads/reply-context-intent';
import { replyToThreadRequest } from '../src/threads/reply-context-request';
import type { ThreadPost } from '../src/threads/thread-page';
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

async function readingPage(activity?: unknown, cursor?: string): Promise<ThreadReadingPage> {
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path.endsWith('/reading-page'))
        return Response.json(
          Object.assign(
            authoredReadingPage(
              thread.thread as ReadingPage['thread'],
              posts.posts.filter((post) => post.id !== thread.thread.firstPost.id) as ReadingPage['replies']['items'],
              accounts.accounts
                .filter((account) => account.state === 'active')
                .map((account) => ({
                  id: account.id,
                  displayName: 'displayName' in account ? account.displayName : null,
                  handle: 'handle' in account ? account.handle : null,
                  avatar: null,
                })),
            ),
            activity === undefined ? {} : { conversationActivity: activity },
          ),
        );
      if (path.endsWith('/posts')) return Response.json(posts);
      if (path.includes('/boards/')) return Response.json(board);
      if (path.endsWith('/accounts')) return Response.json(accounts);
      return Response.json(thread);
    },
  });
  const page = await loadThreadPageWithAuthors(
    client,
    new Request('https://rezics.test/'),
    {},
    { id: thread.thread.id, ...(cursor === undefined ? {} : { cursor }) },
    { sitekey: '', scriptUrl: '' },
    'anonymous',
  );
  if ('redirect' in page) throw new Error('The recorded reading page must not redirect');
  return { ...page, provenanceSubjects: page.subjects };
}
async function render(page: ThreadReadingPage, personal?: ThreadReadingPersonal, pageCurrent = true) {
  const region = createElement(ThreadReading, {
    page,
    pageCurrent,
    personal,
    Post: ThreadReadingPost,
    session: personal ? 'signed-in' : 'signed-out',
    returnTo: '/',
    signedOut: 'Sign in to reply',
    renderHeader: (title) => createElement(ThreadReadingHeader, { page, title }),
    onMutation: async () => {},
    onPageRefresh: async () => page,
  });
  const route = createRootRoute({ component: () => region });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await router.load();
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
  );
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
  const lifecycle: ThreadReadingPage = {
    ...page,
    realm: { id: realm.realm.realmId, title: realm.realm.title, summary: realm.realm.summary },
    posts: {
      ...page.posts,
      posts: page.posts.posts.map((post, index): ThreadPost => {
        if (index === 2 || post.availability !== 'available') return post;
        return index === 0
          ? { ...post, body: null, sha256: null, removed: true, availability: 'erased' }
          : { ...post, body: null, sha256: null, removed: true, availability: 'withheld' };
      }),
    },
  };
  const removed = await render(lifecycle);
  expect(removed).toContain(realm.realm.summary);
  expect(removed).toContain('lg:grid-cols-');
  expect(removed).toContain(m.thread_post_deleted());
  expect(removed).toContain(m.thread_post_withheld());
  expect(removed).toContain(m.thread_reply_parent_deleted());
  for (const post of page.posts.posts.slice(0, 2)) {
    if (post.availability === 'available') {
      for (const text of documentText(post.body).split('\n').filter(Boolean)) expect(removed).not.toContain(text);
    }
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
  const created: CreatedPost = {
    ...parent,
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000090',
    parentId: parent.id,
    body: fromPlainText('A reply returned by the command.', 'blocks'),
  };
  const intent = new ReplyIntent('0192f3a0-6c1e-7b2a-9d4e-000000000091');
  const draft = { title: '', body: created.body, mediaIds: [] };
  const command = intent.prepare(draft, parent.id);
  const calls: { key: string | null; body: string }[] = [];
  let denied = false;
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push({ key: request.headers.get('idempotency-key'), body: await request.text() });
      expect(request.headers.get('authorization')).toBe('Bearer current-viewer');
      if (denied) return Response.json({ code: 'forbidden' }, { status: 403 });
      if (calls.length === 1) throw new Error('Response lost');
      return Response.json({ post: created }, { status: 201 });
    },
  });
  const send = () =>
    replyToThreadRequest(
      { ...intent.prepare(draft, parent.id), threadId: page.thread.id },
      client,
      'Bearer current-viewer',
      () => ({ ok: false, reason: 'forbidden' }),
    );
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
  const html = await render(
    { ...page, posts: { ...page.posts, posts: [...page.posts.posts, result.post] } },
    {
      viewerId: parent.authorId,
      reactions: {},
      reviewVotes: {},
      idempotencyKey: command.idempotencyKey,
    },
  );
  expect(html).toContain(`id="post-${created.id}"`);
  expect(html).toContain(`href="#post-${parent.id}"`);
  expect(html).toContain('A reply returned by the command.');
  expect(html.match(/name="idempotency_key"/g)).toHaveLength(1);
  expect(html).toContain(m.thread_reply_to_post());
});

test('Default thread reading renders the conversation before secondary history and erasure controls while retaining exact revision navigation and mandatory attribution', async () => {
  const page = await readingPage();
  const first = page.posts.posts[0]!;
  if (first.availability !== 'available') throw new Error('The recorded opening post must be readable');
  const nativeAuthor = page.authors?.[first.authorId];
  if (!nativeAuthor) throw new Error('The recorded author batch must contain the opening author');
  const displayName = 'Mira Okabe with a very long unbroken surname ' + 'Okabe'.repeat(10);
  const handle = 'mira_' + 'reading'.repeat(3);
  const html = await render(
    { ...page, authors: { ...page.authors, [first.authorId]: { ...nativeAuthor, displayName, handle } } },
    { viewerId: first.authorId, reactions: {}, reviewVotes: {}, idempotencyKey: 'reading-composition' },
  );
  const column = html.indexOf('data-slot="thread-reading-column"');
  const header = html.indexOf('<header', column);
  const conversation = html.indexOf(`id="thread-${page.thread.id}"`);
  const composer = html.indexOf(`aria-label="${m.thread_reply_label()}"`, conversation);
  const actions = html.indexOf('data-slot="thread-actions"');
  expect(column).toBeGreaterThan(-1);
  expect(header).toBeGreaterThan(column);
  expect(conversation).toBeGreaterThan(header);
  expect(composer).toBeGreaterThan(conversation);
  expect(actions).toBeGreaterThan(composer);
  expect(html.slice(0, conversation)).not.toContain(m.author_erasure_action());
  const secondaryActions = html.slice(actions);
  expect(secondaryActions).toContain(`aria-controls="thread-actions-${page.thread.id}"`);
  expect(secondaryActions).toContain('aria-expanded="false"');
  expect(secondaryActions).toMatch(/<div(?=[^>]*data-slot="collapsible-content")(?=[^>]*hidden="")[^>]*>/);
  expect(secondaryActions).toContain(m.author_erasure_action());

  for (const post of page.posts.posts) {
    if (post.availability !== 'available') continue;
    const start = html.indexOf(`id="post-${post.id}"`);
    const item = html.slice(start, html.indexOf('</footer>', start));
    const body = item.indexOf('data-slot="document-body"');
    const footer = item.indexOf('<footer');
    expect(start).toBeGreaterThan(conversation);
    expect(body).toBeGreaterThan(-1);
    expect(footer).toBeGreaterThan(body);
    for (const text of documentText(post.body).split('\n').filter(Boolean)) expect(item).toContain(text);
    expect(item).toContain(`href="/en/posts/${post.id}/revisions/${post.revisionId}"`);
    const controls = item.slice(footer);
    expect(controls).toContain(`${m.thread_history_licence()}: ${post.licence}`);
    expect(controls).toContain(m.thread_reading_share());
    expect(controls).toContain(m.thread_reply_to_post());
    expect(controls).toContain(m.thread_history_show());
    expect(controls).toContain(`aria-controls="revision-details-${post.id}"`);
    expect(controls).toMatch(/<div(?=[^>]*data-slot="collapsible-content")(?=[^>]*hidden="")[^>]*>/);
    const historyRegion = controls.match(/aria-controls="(post-history-[^"]+)"/);
    expect(historyRegion).not.toBeNull();
    expect(controls).toContain(`id="${historyRegion![1]}" hidden=""`);
  }
  expect(html).toContain(`title="${displayName} @${handle}"`);
  expect(html).toContain(`href="/en/@${handle}"`);
  expect(html).toContain('class="block min-w-0 truncate"');
  expect(html).toContain(m.thread_post_edited());
});

test('native page activity stays independent of loaded replies across opening, continuation and return', async () => {
  for (const cursor of [undefined, 'opaque:/+?=&next', undefined]) {
    const page = await readingPage(
      {
        state: 'current',
        cohort: 'public',
        count: { kind: 'lower-bound', value: 10_000 },
        lastActivityAt: '2026-11-04T00:00:00.000Z',
      },
      cursor,
    );
    const html = await render(page);
    expect(html).toContain('Replies: 10,000+');
    expect(html).toContain('At least 10,000 replies');
    expect(html).toContain('<time dateTime="2026-11-04T00:00:00.000Z"');
    expect(html.indexOf('data-slot="thread-activity"')).toBeLessThan(html.indexOf('id="thread-posts-heading"'));
    expect(await render(page, undefined, false)).not.toContain('Replies: 10,000+');
    page.composed!.viewer = { kind: 'account', id: thread.thread.authorId };
    expect(await render(page)).not.toContain('Replies: 10,000+');
  }
  const zero = await render(
    await readingPage({ state: 'current', cohort: 'public', count: { kind: 'exact', value: 0 }, lastActivityAt: null }),
  );
  expect(zero).toContain('Replies: 0');
  expect(zero).not.toContain(m.board_thread_last_activity({ time: '' }));
  for (const activity of [undefined, { state: 'withheld' }, { state: 'unavailable', retryable: true }]) {
    const html = await render(await readingPage(activity));
    expect(html).toContain(m.board_thread_activity_unavailable());
    expect(html).toContain(m.thread_post_refresh());
    expect(html).not.toContain('Replies: 0');
    expect(html).toContain('data-slot="document-body"');
  }
});
