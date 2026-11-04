import { expect, mock, test } from 'bun:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import { fromMarkdown, fromPlainText } from '@rezics/document';
import { loadReplyParent, validateReplyParentInput } from '../src/threads/reply-parent-read';
import type { ThreadReadingPage } from '../src/threads/thread-reading';
import type { ThreadPost } from '../src/threads/thread-page';
import thread from '../src/kernel/recorded/thread.json';
import posts from '../src/kernel/recorded/thread-posts.json';
import accounts from '../src/kernel/recorded/accounts.json';
import { m } from '../src/paraglide/messages.js';
import { exactRevisionHref } from '../src/threads/exact-revision-href';
import { getLocale } from '../src/paraglide/runtime.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const originalReads = { ...(await import('../src/threads/reads')) };
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;

// This single regression uses the actual default composition and native-shaped HTTP responses.
// Only the server-function request context is supplied locally; native admission is never recorded as positive.
test('Default thread reading identifies a currently disclosed parent and explicitly recovers an off-page parent through one authorized native read without revealing withheld content', async () => {
  const author = { ...accounts.accounts[0]!, displayName: 'Current parent author', handle: 'current_parent' };
  const parent = {
    ...posts.posts[0]!,
    availability: 'available',
    authorId: author.id,
    body: fromMarkdown('Page parent writing >!page concealed!< ![page image](https://image.test/page)', 'blocks'),
  } as Extract<ThreadPost, { availability: 'available' }>;
  const offId = id(501);
  const remote = {
    ...parent,
    id: offId,
    revisionId: id(502),
    licence: 'CC-BY-4.0',
    body: fromMarkdown(
      'Currently admitted remote writing >!remote concealed!< ![private image](https://image.test/private)',
      'blocks',
    ),
  };
  const remoteAuthor = { ...author, displayName: 'Current remote author' };
  let response: unknown = { post: remote };
  let status = 200;
  let identityUnavailable = false;
  let release: ((response: Response) => void) | undefined;
  let reached: (() => void) | undefined;
  let hold = false;
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      const url = new URL(request.url);
      expect(request.method).toBe('GET');
      if (url.pathname === '/v1/accounts') {
        expect(url.searchParams.get('ids')).toBe(author.id);
        return Response.json(identityUnavailable ? { code: 'unavailable' } : { accounts: [remoteAuthor] }, {
          status: identityUnavailable ? 503 : 200,
        });
      }
      expect(url.pathname).toBe(`/v1/posts/${offId}`);
      expect(request.headers.get('authorization')).toBe('Bearer current-viewer');
      if (hold) {
        reached?.();
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return Response.json(response, { status });
    },
  });
  // Exercise the same loader used by reads.ts, with the released current credential.
  mock.module('../src/threads/reads', () => ({
    ...originalReads,
    readReplyParent: async ({ data }: Parameters<typeof originalReads.readReplyParent>[0]) => {
      expect(data).toEqual({ threadId: parent.threadId, parentId: offId, credentialMode: 'session' });
      return loadReplyParent(
        client,
        new Request('https://rezics.test/', {
          headers: { authorization: 'Bearer current-viewer' },
        }),
        {},
        data,
      );
    },
  }));
  try {
    const { ThreadReading } = await import('../src/threads/thread-reading');
    const { ThreadReadingPost } = await import('../src/routes/threads/$id_.$slug');
    type PostProps = ComponentProps<typeof ThreadReadingPost>;
    let captured: PostProps[] = [];
    function CapturePost(props: PostProps) {
      captured.push(props);
      return createElement(ThreadReadingPost, props);
    }
    async function render(region: ReturnType<typeof createElement>) {
      const route = createRootRoute({ component: () => region });
      const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
      await router.load();
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return renderToStaticMarkup(
        createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
      );
    }
    const page: ThreadReadingPage = {
      thread: { ...thread.thread, firstPost: parent } as ThreadReadingPage['thread'],
      posts: {
        posts: [
          parent,
          { ...parent, id: id(503), parentId: parent.id, body: fromPlainText('Local reply.', 'blocks') },
          { ...parent, id: id(504), parentId: offId, body: fromPlainText('Off-page reply.', 'blocks') },
        ],
        next: null,
      },
      authors: { [author.id]: author },
      subjects: [],
      provenanceSubjects: [],
      mentions: null,
      verification: { sitekey: '', scriptUrl: '' },
      now: parent.createdAt,
    };
    async function composition(source = page, readerSubject = author.id) {
      captured = [];
      return render(
        createElement(ThreadReading, {
          page: source,
          readAuthority: {},
          readerSubject,
          personal: undefined,
          session: 'signed-in',
          Post: CapturePost,
          returnTo: '/',
          signedOut: null,
          renderHeader: () => null,
          onMutation: async () => {},
          onPageRefresh: async () => source,
        }),
      );
    }
    const html = await composition();
    expect(calls).toHaveLength(0);
    const contexts = html.match(/<div data-slot="reply-context"[\s\S]*?<\/div>/g)!;
    expect(contexts[0]).toContain(`href="#post-${parent.id}"`);
    expect(contexts[0]).toContain(author.displayName);
    expect(contexts[0]).toContain('Page parent writing');
    expect(contexts[0]).not.toContain('page concealed');
    expect(contexts[0]).not.toContain('page image');
    expect(contexts[1]).toContain(m.thread_reply_parent_view());
    expect(contexts[1]).not.toContain(`href="#post-${offId}"`);
    const originalPost = captured.find((post) => post.post.parentId === offId)!;
    const reader = originalPost.replyParentReader!;
    expect(reader).toBeDefined();
    const preview = async () =>
      (await render(createElement(ThreadReadingPost, originalPost))).match(
        /<div data-slot="reply-context"[\s\S]*?<\/div>/,
      )![0];
    hold = true;
    const firstStarted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    reader.toggle(offId);
    const pending = reader.load(offId);
    expect(reader.load(offId)).toBe(pending);
    await firstStarted;
    expect(await preview()).toContain(m.thread_reply_parent_loading());
    hold = false;
    release!(Response.json({ post: remote }));
    await pending;
    const admitted = await preview();
    expect(calls.filter((request) => new URL(request.url).pathname.includes('/posts/'))).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(admitted).toContain('Current remote author');
    expect(admitted).toContain('Currently admitted remote writing');
    expect(admitted).toContain('CC-BY-4.0');
    expect(admitted).toContain(exactRevisionHref({ postId: offId, revisionId: remote.revisionId }, getLocale()));
    expect(admitted).not.toContain('remote concealed');
    expect(admitted).not.toContain('https://image.test/private');
    expect(admitted).not.toContain('private image');
    expect(admitted).not.toContain(`href="#post-${offId}"`);
    reader.toggle(offId);
    reader.toggle(offId);
    expect(calls).toHaveLength(2);
    for (const refused of [
      { status: 403, body: { code: 'forbidden' } },
      { status: 404, body: { code: 'not_found' } },
      { status: 200, body: { post: { ...remote, availability: 'erased' } } },
      { status: 200, body: { post: { ...remote, availability: 'withheld' } } },
      { status: 200, body: { post: { ...remote, threadId: id(510) } } },
      { status: 200, body: { post: { ...remote, id: id(511) } } },
      { status: 200, body: { post: { ...remote, body: {} } } },
      { status: 200, body: {} },
    ]) {
      status = refused.status;
      response = refused.body;
      const before = calls.length;
      await reader.load(offId);
      expect(calls.length - before).toBe(1);
      const denied = await preview();
      expect(denied).toContain(m.thread_reply_parent_unavailable());
      expect(denied).toContain(m.exact_revision_retry());
      expect(denied).not.toContain('Currently admitted remote writing');
      expect(denied).not.toContain('Current remote author');
      expect(denied).not.toContain(remote.revisionId);
    }
    status = 200;
    const { revisionId: _revision, ...withoutRevision } = remote;
    response = { post: withoutRevision };
    identityUnavailable = true;
    await reader.load(offId);
    const unknown = await preview();
    expect(unknown).toContain(m.thread_author_unknown());
    expect(unknown).toContain('Currently admitted remote writing');
    expect(unknown).not.toContain(m.exact_revision_heading());
    expect(unknown).not.toContain('Current remote author');
    const beforeMissingSession = calls.length;
    expect(
      await loadReplyParent(
        client,
        new Request('https://rezics.test/'),
        {},
        {
          threadId: parent.threadId,
          parentId: offId,
          credentialMode: 'session',
        },
      ),
    ).toEqual({ state: 'unavailable' });
    expect(calls).toHaveLength(beforeMissingSession);
    expect(() =>
      validateReplyParentInput({ threadId: parent.threadId, parentId: '../hidden', credentialMode: 'session' }),
    ).toThrow();
    hold = true;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const late = reader.load(offId);
    await started;
    reader.dispose();
    release!(Response.json({ post: remote }));
    await late;
    expect(reader.get(offId).result.state).toBe('idle');
    await composition(page, id(512));
    expect(captured.find((post) => post.post.parentId === offId)!.replyParentReader).not.toBe(reader);
    for (const availability of ['erased', 'withheld'] as const) {
      await composition({
        ...page,
        posts: {
          ...page.posts,
          posts: page.posts.posts.map((post) =>
            post.id === parent.id ? { ...parent, availability, body: null, sha256: null, removed: true } : post,
          ),
        },
      });
      const localReply = captured.find((post) => post.post.parentId === parent.id)!;
      const removedContext = (await render(createElement(ThreadReadingPost, localReply))).match(
        /<div data-slot="reply-context"[\s\S]*?<\/div>/,
      )![0];
      expect(removedContext).toContain(
        availability === 'erased' ? m.thread_reply_parent_deleted() : m.thread_reply_parent_unavailable(),
      );
      expect(removedContext).not.toContain(author.displayName);
      expect(removedContext).not.toContain('Page parent writing');
    }
  } finally {
    mock.module('../src/threads/reads', () => originalReads);
  }
});
