import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { continuationBoardId, continuationCursor } from '../src/kernel/fake/board-continuation';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';
import { loadBoardPageWithAuthors } from '../src/identity/page-loaders';
import { BoardCommunity } from '../src/threads/board-community';
import type { BoardFeedThread, CommunityBoardPage } from '../src/threads/board-feed-data';
import { threadLocation } from '../src/threads/thread-href';

async function render(page: CommunityBoardPage, sort: 'active' | 'hot' | 'new' = 'active') {
  const route = createRootRoute({ component: () => createElement(BoardCommunity, { page, sort }) });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
}

function hrefCount(markup: string, href: string) {
  return [...markup.matchAll(/href="([^"]+)"/gu)].filter((match) => match[1] === href).length;
}

test('Discussion rows use shared ContentItem headings and destinations while retaining continuation and missing-data behavior', async () => {
  setLocale('en', { reload: false });
  const client = createKernelClient('https://kernel.test', { fetch: createStoryRecordedKernelFetch() });

  const emptyPage = await loadBoardPageWithAuthors(client, { id: continuationBoardId, sort: 'hot' });
  const emptyMarkup = await render(emptyPage, 'hot');
  expect(emptyMarkup).toContain(m.board_threads_page_empty());
  expect(emptyMarkup).not.toContain(m.board_threads_empty());
  const continuationHref = [...emptyMarkup.matchAll(/href="([^"]+)"/gu)]
    .map((match) => match[1]!.replaceAll('&amp;', '&'))
    .find((href) => new URL(href, 'https://site.test').searchParams.has('cursor'));
  expect(continuationHref).toBeDefined();
  if (!continuationHref) throw new Error('The empty Discussion page should keep its continuation link.');
  const continuation = new URL(continuationHref, 'https://site.test');
  expect(continuation.searchParams.get('cursor')).toBe(continuationCursor);
  expect(continuation.searchParams.get('sort')).toBe('hot');

  const page = await loadBoardPageWithAuthors(client, {
    id: continuationBoardId,
    cursor: continuationCursor,
    sort: 'hot',
  });
  const suppliedThreads = page.threads.threads.map((thread) => ({
    ...thread,
    reactions: { like: 3, insightful: 2 },
    replyCount: 7,
    lastActivityAt: '2026-10-31T12:00:00.000Z',
  }));
  const suppliedPage: CommunityBoardPage = {
    ...page,
    threads: { ...page.threads, threads: suppliedThreads },
  };
  const thread = suppliedPage.threads.threads[0]!;
  const author = suppliedPage.authors[thread.authorId];
  expect(author?.handle).toBeTruthy();
  if (!author?.handle) throw new Error('The recorded Discussion thread should retain its supplied author.');

  const markup = await render(suppliedPage, 'hot');
  const primaryHref = threadLocation('en', { id: thread.id, title: thread.title });
  const authorHref = `/en/@${encodeURIComponent(author.handle)}`;
  const feedSection = markup.match(/<section\b[^>]*aria-labelledby="([^"]+)"[^>]*>([\s\S]*?)<\/section>/u);
  if (!feedSection) throw new Error('The discussion feed should be labelled by its own heading.');
  const feedHeading = feedSection[2]!.match(/<h2\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/u);
  expect(feedHeading?.[1]).toBe(feedSection[1]);
  expect(feedHeading?.[2]).toBe(m.board_threads_heading());
  expect(markup).toContain('<ul');
  expect(markup).toMatch(/<li\b(?=[^>]*data-slot="list-row")[^>]*>/u);
  expect(markup).toContain('data-slot="board-feed-card"');
  const heading = markup.match(/<h3\b(?=[^>]*data-slot="board-feed-card")[^>]*>[\s\S]*?<\/h3>/u)?.[0];
  const primaryLink = markup.match(/<a\b(?=[^>]*data-slot="list-row-link")[^>]*>/u)?.[0];
  if (!heading || !primaryLink)
    throw new Error('The discussion row should expose its visible heading and primary link.');
  const headingOpening = heading.slice(0, heading.indexOf('>') + 1);
  const headingId = headingOpening.match(/\bid="([^"]+)"/u)?.[1];
  expect(headingId).toBeDefined();
  expect(primaryLink).toContain(`href="${primaryHref}"`);
  expect(primaryLink).toContain(`aria-labelledby="${headingId}"`);
  expect(hrefCount(markup, primaryHref)).toBeGreaterThanOrEqual(1);
  const primaryEnd = markup.indexOf('</a>', markup.indexOf(primaryLink));
  const authorIndex = markup.indexOf(`href="${authorHref}"`);
  expect(authorIndex).toBeGreaterThan(primaryEnd);
  expect(markup.slice(0, authorIndex)).toMatch(
    /<div\b(?=[^>]*data-content-item-slot="metadata")(?=[^>]*data-slot="list-row-control")[^>]*>[\s\S]*$/u,
  );
  const actionControl = markup.match(
    /<div\b(?=[^>]*data-content-item-slot="actions")(?=[^>]*data-slot="list-row-control")[^>]*>/u,
  )?.[0];
  if (!actionControl) throw new Error('The discussion row should place its actions in the independent control layer.');
  const actionControlIndex = markup.indexOf(actionControl);
  expect(markup.indexOf('data-slot="feed-action-bar"')).toBeGreaterThan(actionControlIndex);
  expect(markup.indexOf(m.feed_action_reply())).toBeGreaterThan(actionControlIndex);
  expect(markup.indexOf(`aria-label="${m.thread_content_more_actions()}"`)).toBeGreaterThan(actionControlIndex);
  expect(markup).toContain(m.feed_action_reply());
  expect(markup).toContain('3');
  expect(markup).toContain('dateTime="2026-10-31T12:00:00.000Z"');

  const sourceThread = page.threads.threads[0]!;
  const missingOpening: BoardFeedThread = {
    ...sourceThread,
    title: null,
    firstPost: {
      ...sourceThread.firstPost,
      availability: 'erased',
      removed: true,
      body: null,
      sha256: null,
    },
  };
  const missingPage: CommunityBoardPage = {
    ...page,
    authors: {},
    threads: { ...page.threads, threads: [missingOpening] },
  };
  const missingMarkup = await render(missingPage, 'hot');
  expect(missingMarkup).toContain(m.threads_untitled());
  expect(missingMarkup).toContain(m.thread_author_unknown());
  expect(missingMarkup).toContain(m.board_feed_opening_unavailable());
  expect(missingMarkup).toContain(m.board_feed_open_thread());
  expect(missingMarkup).not.toContain('Flight notes Watch the baobabs');
  expect(missingMarkup).not.toContain(m.board_feed_reactions({ count: 0 }));
  expect(missingMarkup).not.toContain(m.board_feed_replies({ count: 0 }));

  const deletedThread: BoardFeedThread = { ...sourceThread, availability: 'erased', title: null };
  const deletedPage: CommunityBoardPage = {
    ...page,
    authors: {},
    threads: { ...page.threads, threads: [deletedThread] },
  };
  const deletedMarkup = await render(deletedPage, 'hot');
  expect(deletedMarkup).toContain(m.thread_post_deleted());
  expect(deletedMarkup).not.toContain(m.board_feed_opening_unavailable());
});
