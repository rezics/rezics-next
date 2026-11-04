import { expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { subjectHref } from '../src/subject/subject-href';
import { boardReadingHref, captureBoardReadingReturn, parseBoardReadingReturn } from '../src/threads/board-reading';
import boardThreadsRecording from '../src/kernel/recorded/board-realm-threads.json';
import postRecording from '../src/kernel/recorded/board-realm-thread-posts.json';
import threadRecording from '../src/kernel/recorded/board-realm-thread.json';
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

const { RealmShelf, SpacePage } = await import('../src/community/space-page');
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
    for (const locale of ['en', 'zh-Hant', 'ja'] as const) {
      setLocale(locale, { reload: false });
      const unavailable = async () => ({ kind: 'denied' as const });
      const shelf = await render(
        createElement(RealmShelf, {
          realm: page.realm,
          transport: { boards: unavailable, publications: unavailable, change: unavailable },
          frozen: true,
        }),
      );
      expect(shelf).toContain(m.realm_published_heading());
      expect(shelf).toContain(m.realm_boards_heading());
      for (const subject of page.realm.published) {
        const label = subject.labels[locale] ?? subject.label ?? subject.labels.en ?? '';
        expect(shelf).toContain(
          `${subjectHref({ id: subject.id, label }, locale).href}?realm=${encodeURIComponent(page.realm.id)}`,
        );
      }
      for (const board of page.realm.boards) expect(shelf).toContain(`/boards/${encodeURIComponent(board.id)}`);
    }

    setLocale('en', { reload: false });
    const realmHtml = await render(createElement(SpacePage, { page }), `/en/realms/${page.realm.id}`);
    expect(realmHtml).toContain(page.realm.title);

    const boardId = boardThreadsRecording.threads[0]!.boardId;
    const board = page.realm.boards.find((candidate) => candidate.id === boardId);
    expect(board).toBeDefined();
    const boardRead = await readBoardPage({ data: { id: boardId, credentialMode: 'anonymous' } });
    const thread = boardRead.page.threads.threads.find((candidate) => candidate.id === threadRecording.thread.id);
    expect(thread).toBeDefined();
    const threadPage = await readThreadPage({
      data: { id: threadRecording.thread.id, credentialMode: 'anonymous' },
    });
    if ('redirect' in threadPage) throw new Error('The recorded thread unexpectedly redirected');

    const opening = postRecording.posts.find((post) => post.parentId === null)!;
    const replies = postRecording.posts.filter((post) => post.parentId === opening.id);
    expect(threadPage.posts.posts.map((post) => post.id)).toEqual(postRecording.posts.map((post) => post.id));
    expect(replies.length).toBeGreaterThan(0);
    expect(threadPage.posts.posts.find((post) => post.id === replies[0]!.id)?.parentId).toBe(opening.id);

    const returnSource = captureBoardReadingReturn({
      boardId,
      sort: 'new',
      locale: 'en',
      cursor: 'recorded-board-window',
      focusThreadId: threadRecording.thread.id,
    });
    expect(returnSource).not.toBeNull();
    const returnHref = boardReadingHref(returnSource!);
    expect(parseBoardReadingReturn(returnSource)).toEqual(returnSource);
    expect(returnHref).toBe(
      `/en/boards/${encodeURIComponent(boardId)}?sort=new&cursor=recorded-board-window#board-thread-${threadRecording.thread.id}`,
    );

    setLocale('en', { reload: false });
    const reading = await render(
      createElement(ThreadReading, {
        page: threadPage,
        Post: ThreadReadingPost,
        personal: undefined,
        session: 'signed-out',
        readerSubject: null,
        returnTo: `/en/threads/${threadRecording.thread.id}`,
        signedOut: createElement(SignInPrompt, {
          returnTo: `/en/threads/${threadRecording.thread.id}`,
          label: m.threads_sign_in_to_reply(),
        }),
        renderHeader: (title, current) =>
          createElement(ThreadReadingHeader, { page: current, title, boardReturn: returnHref }),
        onMutation: async () => {},
        onPageRefresh: async () => threadPage,
      }),
      `/en/threads/${threadRecording.thread.id}`,
    );
    expect(reading).toContain(m.thread_posts_heading());
    expect(reading).toContain(m.threads_sign_in_to_reply());
    expect(reading).toContain(`href="${returnHref}"`);
    for (const post of threadPage.posts.posts) {
      const text = post.availability === 'available' ? JSON.stringify(post.body) : '';
      if (text) expect(reading).toContain(text.slice(0, Math.min(text.length, 48)));
    }
  } finally {
    setLocale(oldLocale, { reload: false });
  }
});
