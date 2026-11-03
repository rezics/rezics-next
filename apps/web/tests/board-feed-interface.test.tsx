import { expect, test } from 'bun:test';
import { createElement, Fragment } from 'react';
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
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';
import { BoardFeed } from '../src/threads/board-feed';
import type { BoardPinProducer, BoardPinReadResult, BoardPinSender } from '../src/threads/board-pins/contract';
import type { BoardFeedThread, CommunityBoardPage } from '../src/threads/board-feed-data';
import type { BoardSort } from '../src/threads/board-sort';
import { fullDateTime } from '../src/threads/byline';
import { threadLocation } from '../src/threads/thread-href';

// Authored consumer regressions, UNRUN at delivery. These supplied DTOs establish no native disclosure or signing proof.
const now = '2026-11-01T00:00:00.000Z';
type Feed = {
  page: CommunityBoardPage;
  sort: BoardSort;
  pinRead?: BoardPinReadResult;
  pinProducer?: BoardPinProducer;
  pinSender?: BoardPinSender;
};

async function render(feeds: Feed[]) {
  const root = createRootRoute({
    component: () =>
      createElement(
        Fragment,
        null,
        feeds.map(({ page, sort, pinRead, pinProducer, pinSender }, index) =>
          createElement(BoardFeed, {
            key: index,
            boardId: page.board.id,
            sort,
            page: page.threads,
            authors: page.authors,
            now,
            ...(pinRead === undefined ? {} : { initialPinRead: pinRead }),
            ...(pinProducer === undefined ? {} : { pinProducer }),
            ...(pinSender === undefined ? {} : { pinSender }),
          }),
        ),
      ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
}

function sections(markup: string) {
  return [...markup.matchAll(/<section\b[^>]*aria-labelledby="([^"]+)"[^>]*>([\s\S]*?)<\/section>/gu)];
}

function hrefs(markup: string) {
  return [...markup.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>/gu)].map(
    (match) => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://site.test'),
  );
}

async function fixture() {
  const calls: URL[] = [];
  const recorded = createStoryRecordedKernelFetch();
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      calls.push(new URL(new Request(input, init).url));
      return recorded(input, init);
    },
  });
  const page = await loadBoardPageWithAuthors(client, { id: continuationBoardId, cursor: continuationCursor });
  return { page, calls, client };
}

test('same-Board and distinct-Board instances label only their own localized h2, in populated and empty states', async () => {
  const { page, calls } = await fixture();
  const distinct: CommunityBoardPage = {
    ...page,
    board: { ...page.board, id: emptyBoardId },
    threads: { ...page.threads, threads: [], next: null },
  };
  const readCount = calls.length;
  try {
    for (const locale of ['en', 'zh-Hant', 'de'] as const) {
      setLocale(locale, { reload: false });
      const markup = await render([
        { page, sort: 'active' },
        { page, sort: 'hot' },
        { page: distinct, sort: 'new' },
      ]);
      const feeds = sections(markup);
      expect(feeds).toHaveLength(3);
      const ids: string[] = [];
      for (const feed of feeds) {
        const headings = [...feed[2]!.matchAll(/<h2\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/gu)];
        expect(headings).toHaveLength(1);
        expect(feed[1]).toBe(headings[0]![1]);
        expect(headings[0]![2]).toBe(m.board_threads_heading());
        expect(headings[0]![0]).toMatch(/\btabindex="-1"/u);
        ids.push(feed[1]!);
      }
      expect(new Set(ids).size).toBe(3);
      for (const id of ids)
        expect([...markup.matchAll(/\bid="([^"]+)"/gu)].filter((match) => match[1] === id)).toHaveLength(1);
      expect(markup).not.toContain('id="board-threads-heading"');
      expect(calls).toHaveLength(readCount);
    }
  } finally {
    setLocale('en', { reload: false });
  }
});

test('native order, exact large counts and exact date operands survive long supplied title and byline text', async () => {
  setLocale('en', { reload: false });
  const { page, calls } = await fixture();
  const original = page.threads.threads[0]!;
  const title = `Supplied multilingual title 共讀 ${'UnbrokenTitle'.repeat(30)}`;
  const displayName = `Supplied author 共讀 ${'UnbrokenAuthor'.repeat(30)}`;
  const createdAt = '2026-01-02T03:04:05.678Z';
  const lastActivityAt = '2026-10-31T12:34:56.789Z';
  const first = {
    ...original,
    title,
    createdAt,
    reactions: { like: 1234567890123, insightful: 2 },
    replyCount: 987654321012,
    lastActivityAt,
  };
  const second = { ...original, id: '01a17a3b-09b4-77bf-a24b-1234ebeab5b3', title: 'Second native row' };
  const author = page.authors?.[original.authorId];
  if (!author || author.state !== 'active') throw new Error('The recorded page must supply its active author.');
  const supplied: CommunityBoardPage = {
    ...page,
    authors: { [original.authorId]: { ...author, displayName } },
    threads: { ...page.threads, threads: [first, second], rankRefreshedAt },
  };
  const readCount = calls.length;
  const markup = await render([{ page: supplied, sort: 'hot' }]);
  const headings = [...markup.matchAll(/<h3\b[^>]*data-slot="board-feed-card"[^>]*>([\s\S]*?)<\/h3>/gu)];
  expect(headings.map((heading) => heading[1])).toEqual([title, 'Second native row']);
  expect(markup).toContain(displayName);
  expect(markup).toContain('data-slot="feed-action-bar"');
  expect(markup).toContain(m.feed_action_reply());
  expect(markup).toContain('1234567890123');
  expect(markup).toContain(`dateTime="${createdAt}"`);
  expect(markup).toContain(`dateTime="${lastActivityAt}"`);
  expect(markup).toContain(`title="${fullDateTime(createdAt, 'en')}"`);
  expect(markup).toContain(`title="${fullDateTime(lastActivityAt, 'en')}"`);
  expect(markup).toContain('Flight notes Watch the baobabs');
  const primary = markup.match(/<a\b[^>]*data-slot="list-row-link"[^>]*>[\s\S]*?<\/a>/u)?.[0];
  expect(primary).toBeDefined();
  expect(primary).not.toMatch(/<button|<summary|<time|<a\b[^>]*href=[\s\S]*<a\b/u);
  const firstHref = threadLocation('en', { id: first.id, title });
  expect(hrefs(markup).filter((url) => url.pathname === firstHref).length).toBeGreaterThanOrEqual(1);
  expect(markup).not.toContain(m.board_feed_reactions({ count: 0 }));
  expect(calls).toHaveLength(readCount);
});

test('plain sort anchors reset continuation and sparse pages preserve exact opaque bytes for every selection', async () => {
  setLocale('en', { reload: false });
  const { page, calls } = await fixture();
  const cursor = 'signed+board/next==?keep=%2F&opaque=雪';
  const sparse: CommunityBoardPage = {
    ...page,
    threads: { ...page.threads, threads: [], next: cursor, rankRefreshedAt },
  };
  const readCount = calls.length;
  for (const sort of ['active', 'hot', 'new'] as const) {
    const markup = await render([{ page: sparse, sort }]);
    expect(markup).toContain(m.board_threads_page_empty());
    expect(markup).not.toContain(m.board_threads_empty());
    expect(markup).not.toContain('<ul');
    const targets = hrefs(markup).filter((url) => url.pathname.endsWith(page.board.id));
    expect(targets).toHaveLength(4);
    const [active, hot, newest, next] = targets;
    expect(active!.search).toBe('');
    expect(hot!.search).toBe('?sort=hot');
    expect(newest!.search).toBe('?sort=new');
    expect(next!.searchParams.get('cursor')).toBe(cursor);
    expect(next!.searchParams.get('sort')).toBe(sort === 'active' ? null : sort);
    expect([...next!.searchParams.keys()]).toEqual(sort === 'active' ? ['cursor'] : ['cursor', 'sort']);
    expect([...markup.matchAll(/aria-current="page"/gu)]).toHaveLength(1);
    const current = markup.match(/<a\b[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/a>/u)?.[1];
    expect(current).toBe(
      sort === 'active' ? m.board_sort_active() : sort === 'hot' ? m.board_sort_hot() : m.board_sort_new(),
    );
    expect(markup.includes('<details')).toBe(sort !== 'new');
    expect(markup.includes(`dateTime="${rankRefreshedAt}"`)).toBe(sort !== 'new');
    const final = await render([
      { page: { ...sparse, threads: { ...sparse.threads, next: null, rankRefreshedAt: null } }, sort },
    ]);
    expect(final).toContain(m.board_threads_empty());
    expect(final).not.toContain(m.board_threads_page_empty());
    expect(final).not.toContain(m.threads_next_page());
    expect(final).not.toContain('<details');
    expect(hrefs(final)).toHaveLength(3);
  }
  expect(calls).toHaveLength(readCount);
});

test('unavailable openings, erased rows and unavailable/deleted authors retain their separate meanings and omit hidden text', async () => {
  setLocale('en', { reload: false });
  const { page, calls } = await fixture();
  const original = page.threads.threads[0]!;
  const opening: BoardFeedThread = {
    ...original,
    title: null,
    firstPost: { ...original.firstPost, availability: 'erased', body: null, sha256: null, removed: true },
  };
  const erased: BoardFeedThread = { ...opening, id: '01a17a3b-09b4-77bf-a24b-1234ebeab5b3', availability: 'erased' };
  const missing: CommunityBoardPage = {
    ...page,
    authors: null,
    threads: { ...page.threads, threads: [opening, erased] },
  };
  const markup = await render([{ page: missing, sort: 'active' }]);
  expect(markup).toContain(m.board_feed_opening_unavailable());
  expect(markup).toContain(m.threads_untitled());
  expect(markup).toContain(m.thread_author_unknown());
  expect(markup).toContain(m.thread_post_deleted());
  expect(markup).not.toContain('Flight notes');
  expect(markup).not.toContain('Watch the baobabs');
  expect(markup).not.toContain(original.title!);
  expect(markup).not.toContain(m.board_feed_reactions({ count: 0 }));
  expect(markup).not.toContain(m.board_feed_replies({ count: 0 }));
  expect(markup).not.toContain(m.realm_join());
  const deleted: CommunityBoardPage = {
    ...missing,
    authors: { [original.authorId]: { id: original.authorId, state: 'deleted', kind: 'actor' } },
  };
  const removedAuthor = await render([{ page: deleted, sort: 'active' }]);
  expect(removedAuthor).toContain(m.thread_author_deleted());
  expect(removedAuthor).not.toContain(m.thread_author_unknown());
  expect(removedAuthor).not.toContain('/@mira');
  expect(removedAuthor).not.toContain('Mira Okabe');
  expect(calls.filter((url) => url.pathname === '/v1/accounts')).toHaveLength(1);
  expect(calls.some((url) => /^\/v1\/(threads|posts|media)\//u.test(url.pathname))).toBe(false);
});

test('rank explanation requires a supplied valid ranked date, never a fabricated refresh time', async () => {
  setLocale('en', { reload: false });
  const { page } = await fixture();
  for (const supplied of [null, 'not-a-date']) {
    const markup = await render([
      { page: { ...page, threads: { ...page.threads, rankRefreshedAt: supplied } }, sort: 'hot' },
    ]);
    expect(markup).not.toContain('<details');
    expect(markup).not.toContain(m.board_feed_order_help());
  }
  const markup = await render([{ page: { ...page, threads: { ...page.threads, rankRefreshedAt } }, sort: 'active' }]);
  expect(markup).toMatch(/<details\b[^>]*>\s*<summary\b/u);
  expect(markup).toContain(`dateTime="${rankRefreshedAt}"`);
  expect(markup).toContain(`title="${fullDateTime(rankRefreshedAt, 'en')}"`);
  expect(markup).toContain(m.board_feed_order_help());
});

test('native pin states decorate the ordinary feed in its supplied order with only explicit row actions', async () => {
  setLocale('en', { reload: false });
  const { page } = await fixture();
  const first = page.threads.threads[0]!;
  const second: BoardFeedThread = {
    ...first,
    id: '01a17a3b-09b4-77bf-a24b-1234ebeab5b3',
    title: 'Second native row',
  };
  const orderedPage: CommunityBoardPage = {
    ...page,
    threads: { ...page.threads, threads: [first, second] },
  };
  const pinRead: BoardPinReadResult = {
    state: 'ready',
    boardId: page.board.id,
    management: 'allowed',
    // Reverse order on purpose. These statuses decorate rows and never order them.
    threads: [
      { threadId: second.id, pinned: false, actions: ['pin'] },
      { threadId: first.id, pinned: true, actions: ['unpin'] },
    ],
  };
  const markup = await render([
    {
      page: orderedPage,
      sort: 'active',
      pinRead,
      pinSender: { subject: 'moderator', csrfToken: 'private-csrf' },
    },
  ]);
  const titles = [...markup.matchAll(/<h3\b[^>]*data-slot="board-feed-card"[^>]*>([\s\S]*?)<\/h3>/gu)].map(
    (match) => match[1],
  );
  expect(titles).toEqual([first.title, second.title]);
  expect(markup.match(new RegExp(m.board_pin_badge(), 'gu'))).toHaveLength(1);
  expect(markup).toContain(m.board_pin_unpin());
  expect(markup).toContain(m.board_pin_pin());
  expect(markup.match(/<ul\b/gu)).toHaveLength(1);
  expect(markup).not.toContain('private-csrf');
  expect(markup).not.toContain('moderator');
});

test('denied and unavailable pin reads keep ordinary discussions visible and never invent pin badges', async () => {
  setLocale('en', { reload: false });
  const { page } = await fixture();
  for (const pinRead of [{ state: 'denied' }, { state: 'unavailable' }] as const) {
    const markup = await render([{ page, sort: 'active', pinRead }]);
    expect(markup).toContain(page.threads.threads[0]!.title!);
    expect(markup).toContain(pinRead.state === 'denied' ? m.board_pin_read_denied() : m.board_pin_unavailable());
    expect(markup).not.toContain('group/badge');
    expect(markup).not.toContain(m.board_pin_pin());
    expect(markup).toContain(m.board_community_retry());
  }
});
