import { expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { subjectHref } from '../src/subject/subject-href';
import { boardReadingHref, captureBoardReadingReturn, parseBoardReadingReturn } from '../src/threads/board-reading';
import { realmReadingReturn, realmReadingSelection, realmShelfReturn } from '../src/community/realm-reading-return';
import { threadLocation } from '../src/threads/thread-href';
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

const { AnonymousSessionContext } = await import('../src/session/query');

const { subjectCommunityVisitReturn, withSubjectVisitReturn } =
  await import('../src/features/pages/subject-visit-navigation');
const { boardSearch } = await import('../src/routes/boards/$id');
const { threadCreationPreset } = await import('../src/threads/thread-creation-lifetime');
const { SpacePage } = await import('../src/community/space-page');
const { loadSpacePage } = await import('../src/community/space');
const { readBoardPage, readThreadPage } = await import('../src/threads/reads');
const { ThreadReading } = await import('../src/threads/thread-reading');
const { BoardCommunity } = await import('../src/threads/board-community');
const { ThreadReadingHeader, ThreadReadingPost } = await import('../src/routes/threads/$id_.$slug');
const { SignInPrompt } = await import('../src/threads/composer');
const { getLocale, setLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');

async function render(component: ReactNode, path = '/') {
  const client = new QueryClient();
  const root = createRootRoute({ component: () => component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [path] }) });
  await router.load();
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AnonymousSessionContext.Provider, { value: true }, createElement(RouterProvider, { router })),
      ),
    );
  } finally {
    client.clear();
  }
}

async function withStoryRequest<T>(read: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: new URL('https://site.example.test/en/realms/atlas-member') },
  });
  try {
    return await read();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('public Realm destinations and the native discussion reader preserve their exact sources and browser return', async () => {
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

    const threadPage = await withStoryRequest(() =>
      readThreadPage({ data: { id: threadRecording.thread.id, credentialMode: 'anonymous' } }),
    ).catch((error) => {
      throw new Error('The recorded public thread did not load through its native reader', { cause: error });
    });
    if ('redirect' in threadPage) throw new Error('The native thread unexpectedly redirected');
    const boardId = threadPage.thread.boardId;
    const boardRead = await withStoryRequest(() =>
      readBoardPage({ data: { id: boardId, sort: 'new', credentialMode: 'anonymous' } }),
    ).catch((error) => {
      throw new Error(`The recorded discussion board ${boardId} did not load through its native reader`, {
        cause: error,
      });
    });
    expect(boardRead.page.threads.threads.some((candidate) => candidate.id === threadPage.thread.id)).toBe(true);
    const boardHtml = await render(
      createElement(BoardCommunity, { page: boardRead.page, sort: 'new' }),
      `/en/boards/${boardId}`,
    );
    expect(boardHtml).toContain(boardRead.page.board.title);
    const occurrence = boardRead.page.threads.threads.findIndex((candidate) => candidate.id === threadPage.thread.id);
    const boardOrigin = `/en/boards/${boardId}?sort=new#board-thread-${threadPage.thread.id}--ordinary-${occurrence}`;
    expect(boardHtml).toContain(
      `href="${threadLocation('en', { id: threadPage.thread.id, title: threadPage.thread.title }, undefined, undefined, undefined, boardOrigin)}"`,
    );

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
      focusThreadId: threadPage.thread.id,
    });
    expect(returnSource).not.toBeNull();
    const returnHref = boardReadingHref(returnSource!);
    expect(parseBoardReadingReturn(returnSource)).toEqual(returnSource);
    expect(returnHref).toBe(`/en/boards/${encodeURIComponent(boardId)}?sort=new#board-thread-${threadPage.thread.id}`);

    setLocale('en', { reload: false });
    const reading = await render(
      createElement(ThreadReading, {
        page: threadPage,
        Post: ThreadReadingPost,
        personal: undefined,
        session: 'signed-out',
        readerSubject: null,
        returnTo: `/en/threads/${threadPage.thread.id}`,
        signedOut: createElement(SignInPrompt, {
          returnTo: `/en/threads/${threadPage.thread.id}`,
          label: m.threads_sign_in_to_reply(),
        }),
        renderHeader: (title, current) =>
          createElement(ThreadReadingHeader, { page: current, title, boardReturn: returnHref }),
        onMutation: async () => {},
        onPageRefresh: async () => threadPage,
      }),
      `/en/threads/${threadPage.thread.id}`,
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

test('the real Realm shelves hand consumed returns to Board, work and participation without mapping a work to a Board', async () => {
  const page = await loadSpacePage(
    kernel,
    new Request('https://site.example.test/en/spaces/atlas-member'),
    {},
    { address: 'atlas-member' },
    'anonymous',
  );
  if (!page.realm) throw new Error('Recorded Realm unavailable');
  expect(page.realm.published.length).toBeGreaterThan(0);
  const previous = getLocale;
  try {
    for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es'] as const) {
      overwriteGetLocale(() => locale);
      const origin = `/${locale}/realms/${page.realm.id}`;
      const html = await render(createElement(SpacePage, { page }), origin);
      const links = [...html.matchAll(/href="([^"]+)"/g)].map(
        (match) => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://site.test'),
      );
      expect(html.match(/id="realm-boards-heading"/g) ?? []).toHaveLength(1);
      expect(html.match(/id="realm-published-heading"/g) ?? []).toHaveLength(1);
      for (const board of page.realm.boards) {
        const destination = links.find((url) => url.pathname.endsWith(`/boards/${board.id}`));
        const returnTo = destination?.searchParams.get('returnTo');
        expect(returnTo).toBe(`${origin}?node=boards#realm-board-${board.id}`);
        expect(boardSearch({ returnTo })).toEqual({ returnTo });
        expect(threadCreationPreset({ returnTo }, locale).returnTo).toBe(returnTo);
        const reading = captureBoardReadingReturn({ boardId: board.id, locale, sort: 'new', returnTo: returnTo! });
        expect(
          new URL(boardReadingHref(parseBoardReadingReturn(reading)!), 'https://site.test').searchParams.get(
            'returnTo',
          ),
        ).toBe(returnTo);
      }
      for (const subject of page.realm.published) {
        const destination = links.find((url) => url.pathname.includes(`/subjects/${subject.id}/`));
        expect(destination?.searchParams.get('realm')).toBe(page.realm.id);
        expect(destination?.searchParams.get('via')).toBe(
          `${origin}?node=publications#realm-publication-${subject.id}`,
        );
        expect(destination?.searchParams.has('board')).toBe(false);
      }
      const selected = realmShelfReturn({
        href: origin,
        locale,
        node: 'publications',
        cursor: 'native/+window=',
        id: page.realm.published[0]?.id,
      });
      expect(realmReadingSelection(selected)).toMatchObject({ node: 'publications', cursor: 'native/+window=' });
      expect(realmReadingReturn(`${origin}?private=draft`, locale)).toBeUndefined();
      expect(realmReadingReturn(`${origin}?node=boards&cursor=a&cursor=b`, locale)).toBeUndefined();
      expect(realmReadingReturn(selected, locale === 'en' ? 'ja' : 'en')).toBeUndefined();
      expect(realmReadingReturn(`//elsewhere.test${origin}`, locale)).toBeUndefined();
    }
    overwriteGetLocale(() => 'en');
    const subject = page.realm.published[0]!;
    const source = `/en/subjects/${subject.id}/work/reviews?realm=${page.realm.id}&node=review-list&cursor=original%2Fwindow#subject-community-review-list`;
    expect(subjectCommunityVisitReturn(source, 'en')).toBe(source);
    expect(
      new URL(
        withSubjectVisitReturn(subjectHref({ id: subject.id, label: 'work' }, 'en').href, source, 'en'),
        'https://site.test',
      ).searchParams.get('via'),
    ).toBe(source);
  } finally {
    overwriteGetLocale(previous);
  }
});
