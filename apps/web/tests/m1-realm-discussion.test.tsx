import { expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { subjectHref } from '../src/subject/subject-href';
import { boardReadingHref, captureBoardReadingReturn, parseBoardReadingReturn } from '../src/threads/board-reading';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const kernel = createKernelClient('http://kernel.local', {
  fetch: (await import('../src/kernel/fake')).createStoryRecordedKernelFetch(),
});
const kernelClientModule = await import('../src/kernel/client');
mock.module('../src/kernel/client', () => ({ ...kernelClientModule, kernelClient: () => kernel }));

const session = await import('../src/session/query');
let currentSession: { state: 'signed-in' | 'signed-out'; csrfToken: string | null; subject: string | null } = {
  state: 'signed-out',
  csrfToken: null,
  subject: null,
};
mock.module('../src/session/query', () => ({ ...session, useSession: () => currentSession }));

const { SpacePage } = await import('../src/community/space-page');
const { loadSpacePage } = await import('../src/community/space');
const { readBoardPage, readThreadPage } = await import('../src/threads/reads');
const { ThreadReading } = await import('../src/threads/thread-reading');
const { ThreadReadingHeader, ThreadReadingPost } = await import('../src/routes/threads/$id_.$slug');
const { SignInPrompt } = await import('../src/threads/composer');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');

async function render(component: ReactNode, path = '/') {
  const client = new QueryClient();
  const root = createRootRoute({ component: () => component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [path] }) });
  await router.load();
  try {
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  } finally {
    client.clear();
  }
}

test('the public Realm shelves lead to their exact work and board sources, then return to the same discussion window', async () => {
  const request = new Request('https://site.example.test/en/spaces/atlas-member');
  const page = await loadSpacePage(kernel, request, {}, { address: 'atlas-member' }, 'anonymous');
  if (!page.realm) throw new Error('The recorded Realm carrier is unavailable');

  const oldLocale = getLocale();
  try {
    setLocale('en', { reload: false });
    const realmHtml = await render(createElement(SpacePage, { page }), `/en/realms/${page.realm.id}`);
    expect(realmHtml).toContain(page.realm.title);
    expect(realmHtml).toContain(m.realm_published_heading());
    expect(realmHtml).toContain(m.realm_boards_heading());
    for (const subject of page.realm.published) {
      const label = subject.labels.en ?? subject.label ?? '';
      expect(realmHtml).toContain(
        `${subjectHref({ id: subject.id, label }, 'en').href}?realm=${encodeURIComponent(page.realm.id)}`,
      );
    }
    for (const board of page.realm.boards) expect(realmHtml).toContain(`/boards/${encodeURIComponent(board.id)}`);

    const board = page.realm.boards.find((candidate) => candidate.visibility === 'published');
    if (!board) throw new Error('The admitted Realm has no readable board');
    const boardId = board.id;
    const boardRead = await readBoardPage({ data: { id: boardId, sort: 'new', credentialMode: 'anonymous' } });
    const thread = boardRead.page.threads.threads.find((candidate) => candidate.availability === 'available');
    if (!thread) throw new Error('The admitted board has no readable thread');
    const threadPage = await readThreadPage({
      data: { id: thread.id, credentialMode: 'anonymous' },
    });
    if ('redirect' in threadPage) throw new Error('The native thread unexpectedly redirected');

    const openingId = threadPage.thread.firstPost.id;
    const replies = threadPage.posts.posts.filter((post) => post.parentId === openingId);
    expect(replies.length).toBeGreaterThan(0);
    expect(threadPage.posts.posts[0]?.id).toBe(openingId);
    const earlierPostIds = new Set<string>();
    for (const post of threadPage.posts.posts) {
      if (post.parentId !== null) expect(earlierPostIds.has(post.parentId)).toBe(true);
      earlierPostIds.add(post.id);
    }

    const returnSource = captureBoardReadingReturn({
      boardId,
      sort: 'new',
      locale: 'en',
      focusThreadId: thread.id,
    });
    expect(returnSource).not.toBeNull();
    const returnHref = boardReadingHref(returnSource!);
    expect(parseBoardReadingReturn(returnSource)).toEqual(returnSource);
    expect(returnHref).toBe(`/en/boards/${encodeURIComponent(boardId)}?sort=new#board-thread-${thread.id}`);

    setLocale('en', { reload: false });
    const reading = await render(
      createElement(ThreadReading, {
        page: threadPage,
        Post: ThreadReadingPost,
        personal: undefined,
        session: 'signed-out',
        readerSubject: null,
        returnTo: `/en/threads/${thread.id}`,
        signedOut: createElement(SignInPrompt, {
          returnTo: `/en/threads/${thread.id}`,
          label: m.threads_sign_in_to_reply(),
        }),
        renderHeader: (title, current) =>
          createElement(ThreadReadingHeader, { page: current, title, boardReturn: returnHref }),
        onMutation: async () => {},
        onPageRefresh: async () => threadPage,
      }),
      `/en/threads/${thread.id}`,
    );
    expect(reading).toContain(m.thread_posts_heading());
    expect(reading).toContain(m.threads_sign_in_to_reply());
    expect(reading).toContain(`href="${returnHref}"`);
    for (const post of threadPage.posts.posts) {
      if (post.availability !== 'available') continue;
      const firstBlock = post.body.doc.content[0] as { content?: { text?: string }[] } | undefined;
      const text = firstBlock?.content?.map((node) => node.text ?? '').join('') ?? '';
      if (text) expect(reading).toContain(text);
    }
  } finally {
    setLocale(oldLocale, { reload: false });
  }
});
