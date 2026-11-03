import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import { loadBoardPageWithAuthors } from '../src/identity/page-loaders';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import {
  continuationBoardId,
  continuationCursor,
  emptyBoardId,
  rankRefreshedAt,
} from '../src/kernel/fake/board-continuation';
import threads from '../src/kernel/recorded/board-threads.json';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';
import { BoardThreads } from '../src/threads/board-continuation';
import type { BoardSort } from '../src/threads/board-sort';

type Page = Awaited<ReturnType<typeof loadBoardPageWithAuthors>>;
async function render(page: Page, sort: BoardSort) {
  const root = createRootRoute({
    component: () =>
      createElement(BoardThreads, {
        boardId: page.board.id,
        sort,
        page: page.threads,
        authors: page.authors,
        now: page.now,
      }),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
}

test('Next traverses an empty visible page to a returned thread with the exact cursor and the same sort', async () => {
  setLocale('en', { reload: false });
  for (const sort of ['active', 'hot', 'new'] as const) {
    const calls: URL[] = [];
    const recorded = createStoryRecordedKernelFetch();
    const client = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        calls.push(new URL(new Request(input, init).url));
        return recorded(input, init);
      },
    });
    const first = await loadBoardPageWithAuthors(client, {
      id: continuationBoardId,
      ...(sort === 'active' ? {} : { sort }),
    });
    const html = await render(first, sort);
    expect(html).toContain(m.board_threads_page_empty());
    expect(html).not.toContain(m.board_threads_empty());
    const href = [...html.matchAll(/href="([^"]+)"/gu)]
      .map((match) => match[1]!.replaceAll('&amp;', '&'))
      .find((value) => new URL(value, 'https://site.test').searchParams.has('cursor'));
    expect(href).toBeDefined();
    const target = new URL(href!, 'https://site.test');
    expect(target.searchParams.get('cursor')).toBe(continuationCursor);
    expect(target.searchParams.get('sort')).toBe(sort === 'active' ? null : sort);
    expect(calls.filter((url) => url.pathname === `/v1/boards/${continuationBoardId}/page`)).toHaveLength(1);
    expect(calls.some((url) => url.pathname === '/v1/accounts')).toBe(false);
    const continued = await loadBoardPageWithAuthors(client, {
      id: continuationBoardId,
      cursor: target.searchParams.get('cursor')!,
      ...(sort === 'active' ? {} : { sort }),
    });
    const visible = await render(continued, sort);
    expect(visible).toContain(threads.threads[0]!.title);
    expect(visible).not.toContain(m.board_threads_page_empty());
    expect(visible).not.toContain(m.threads_next_page());
    expect(visible.includes(`dateTime="${rankRefreshedAt}"`)).toBe(sort !== 'new');
    const pages = calls.filter((url) => url.pathname === `/v1/boards/${continuationBoardId}/page`);
    expect(pages.map((url) => url.searchParams.get('cursor'))).toEqual([null, continuationCursor]);
    expect(pages.map((url) => url.searchParams.get('sort'))).toEqual([
      sort,
      sort,
    ]);
    const terminal = await loadBoardPageWithAuthors(client, { id: emptyBoardId });
    const empty = await render(terminal, sort);
    expect(empty).toContain(m.board_threads_empty());
    expect(empty).not.toContain(m.threads_next_page());
    expect(empty).not.toContain('Ranking refreshed');
    expect(visible).not.toContain('Replies:');
  }
});

test('a continued board or page refusal stays a failure rather than becoming an empty success', async () => {
  for (const status of [404, 503]) {
      const recorded = createStoryRecordedKernelFetch();
      const client = createKernelClient('https://kernel.test', {
        fetch: async (input, init) => {
          const url = new URL(new Request(input, init).url);
          const refused = url.pathname === `/v1/boards/${continuationBoardId}/page`;
          return refused
            ? Response.json({ code: status === 404 ? 'not_found' : 'dependency_unavailable' }, { status })
            : recorded(input, init);
        },
      });
      const result = loadBoardPageWithAuthors(client, { id: continuationBoardId, cursor: continuationCursor });
      if (status === 404) await expect(result).rejects.toMatchObject({ isNotFound: true });
      else await expect(result).rejects.toThrow(/Kernel .* read failed/u);
    }
});
