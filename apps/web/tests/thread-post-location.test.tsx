import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { fromPlainText } from '@rezics/document';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadThreadPage, type LoadedThreadPage } from '../src/threads/thread-page';
import { threadLocation, threadSearch } from '../src/threads/thread-href';
import thread from '../src/kernel/recorded/thread.json';
import recorded from '../src/kernel/recorded/thread-posts.json';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { ThreadReading } = await import('../src/threads/thread-reading');
const { ThreadReadingHeader, ThreadReadingPost } = await import('../src/routes/threads/$id_.$slug');
const target = {
  ...recorded.posts[0]!,
  id: '0192f3a0-6c1e-7b2a-9d4e-000000009999',
  body: fromPlainText('Linked post beyond the first page.', 'blocks'),
};
const cursor = 'signed-predecessor/opaque+cursor';
const verification = { sitekey: '', scriptUrl: '' };

function native(mode: 'available' | 'missing' | 'withdrawn') {
  const paths: string[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      paths.push(url.pathname + url.search);
      expect(request.headers.get('authorization')).toBeNull();
      if (url.pathname === `/v1/threads/${thread.thread.id}`) return Response.json(thread);
      if (url.pathname.endsWith('/location')) {
        expect(request.cache).toBe('no-store');
        return mode === 'missing' ? Response.json({}, { status: 404 }) : Response.json({ cursor });
      }
      if (url.pathname.endsWith('/posts')) {
        if (mode === 'missing') {
          expect(url.search).toBe('');
          return Response.json({ posts: [], next: null });
        }
        expect(url.searchParams.get('cursor')).toBe(cursor);
        return Response.json({ posts: mode === 'withdrawn' ? [] : [target], next: 'signed-next' });
      }
      if (url.pathname.startsWith('/v1/boards/')) return Response.json({}, { status: 404 });
      throw new Error(`Unexpected read: ${url}`);
    },
  });
  return { client, paths };
}

async function render(loaded: LoadedThreadPage) {
  const page = { ...loaded, authors: {}, subjects: [], provenanceSubjects: [], now: '2030-01-01T00:00:00Z' };
  const root = createRootRoute({
    component: () => (
      <ThreadReading
        page={page}
        Post={ThreadReadingPost}
        personal={undefined}
        session="signed-out"
        returnTo="/"
        signedOut="Sign in"
        renderHeader={(title) => <ThreadReadingHeader page={page} title={title} />}
        onMutation={async () => {}}
        onPageRefresh={async () => page}
      />
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const request = new Request('https://web.test/en/threads/linked');
const input = { id: thread.thread.id, post: target.id, cursor: 'unrelated-old-page' };

test('a cross-page link renders the exact admitted post through one native page, with ordinary continuation', async () => {
  const { client, paths } = native('available');
  const { moderationTargetContent } = await import('../src/moderation/target-content');
  const evidence = {
    id: target.id,
    kind: 'post',
    state: 'available',
    post: target,
    thread: thread.thread,
    now: '2030-01-01T00:00:00Z',
    documentMedia: { kind: 'unavailable' },
  };
  const markup = renderToStaticMarkup(
    moderationTargetContent({
      key: `post:${target.id}`,
      kind: 'post',
      value: { moderationEvidence: evidence },
    }),
  );
  const destination = new URL(/href="([^"]+)"/.exec(markup)![1]!, request.url);
  const linkedInput = { id: input.id, ...threadSearch(Object.fromEntries(destination.searchParams)) };
  const page = await loadThreadPage(client, request, {}, linkedInput, verification, 'anonymous');
  expect(page.posts.posts.map((post) => post.id)).toEqual([target.id]);
  const html = await render(page);
  expect(html).toContain(`id="post-${target.id}"`);
  expect(html).toContain('Linked post beyond the first page.');
  expect(html).toContain('?cursor=signed-next');
  expect(html).not.toContain(`?post=${target.id}`);
  expect(paths.filter((path) => path.includes('/location'))).toHaveLength(1);
  expect(paths.filter((path) => path.includes('/posts?'))).toHaveLength(1);
});

for (const mode of ['missing', 'withdrawn'] as const) {
  test(`${mode} linked posts disclose no previous body and offer recovery to the thread beginning`, async () => {
    const { client, paths } = native(mode);
    const page = await loadThreadPage(client, request, {}, input, verification, 'anonymous');
    expect(page.linkedPostUnavailable).toBe(true);
    const html = await render(page);
    expect(html).not.toContain('Linked post beyond the first page.');
    expect(html).not.toContain(`id="post-${target.id}"`);
    expect(html).toContain('role="status"');
    expect(html).toContain(`href="${threadLocation('en', thread.thread)}"`);
    expect(paths.filter((path) => /\/posts(?:\?|$)/.test(path))).toHaveLength(1);
  });
}

test('canonical redirects retain a linked post and fragment before any downstream reads', async () => {
  const { client, paths } = native('available');
  const page = await loadThreadPage(
    client,
    request,
    {},
    { ...input, expectedSlug: 'obsolete-title' },
    verification,
    'anonymous',
  );
  expect('redirect' in page).toBe(true);
  expect(paths).toEqual([`/v1/threads/${thread.thread.id}`]);
  const search = threadSearch({ post: target.id, cursor });
  for (const title of [thread.thread.title, null]) {
    const href = threadLocation('en', { id: thread.thread.id, title }, search.cursor, search.post);
    const url = new URL(href, 'https://web.test');
    expect(url.searchParams.get('post')).toBe(target.id);
    expect(url.searchParams.get('cursor')).toBe(cursor);
    expect(url.hash).toBe(`#post-${target.id}`);
  }
});
