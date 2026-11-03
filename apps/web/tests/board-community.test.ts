import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import { loadBoardPageWithAuthors } from '../src/identity/page-loaders';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { continuationBoardId, continuationCursor } from '../src/kernel/fake/board-continuation';
import realmBoard from '../src/kernel/recorded/board-realm.json';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { BoardCommunity } = await import('../src/threads/board-community');
import { boardThreadPreview, type CommunityBoardPage } from '../src/threads/board-feed-data';
import type { BoardSort } from '../src/threads/board-sort';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function render(page: CommunityBoardPage, sort: BoardSort = 'active') {
  const root = createRootRoute({ component: () => createElement(BoardCommunity, { page, sort }) });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
}

test('the actual community feed continues an empty page, preserves every sort and opens disclosed previews with supplied counts', async () => {
  setLocale('en', { reload: false });
  for (const sort of ['active', 'hot', 'new'] as const) {
    const calls: URL[] = [];
    const recorded = createStoryRecordedKernelFetch();
    const client = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push(new URL(request.url));
        const response = await recorded(input, init);
        if (new URL(request.url).pathname.endsWith('/threads') && new URL(request.url).searchParams.has('cursor')) {
          const body: unknown = await response.json();
          if (!record(body) || !Array.isArray(body.threads)) throw new Error('The recorded thread page is missing.');
          return Response.json({
            ...body,
            threads: body.threads.map((thread: unknown) => {
              if (!record(thread)) throw new Error('The recorded thread row is missing.');
              return { ...thread, reactions: { like: 3, insightful: 2 }, replyCount: 7 };
            }),
          });
        }
        return response;
      },
    });
    const first = await loadBoardPageWithAuthors(client, {
      id: continuationBoardId,
      ...(sort === 'active' ? {} : { sort }),
    });
    const empty = await render(first, sort);
    expect(empty).toContain(m.board_threads_page_empty());
    expect(empty).not.toContain(m.board_threads_empty());
    const target = [...empty.matchAll(/href="([^"]+)"/gu)]
      .map((match) => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://site.test'))
      .find((url) => url.searchParams.has('cursor'))!;
    expect(target.searchParams.get('cursor')).toBe(continuationCursor);
    expect(target.searchParams.get('sort')).toBe(sort === 'active' ? null : sort);
    const page = await loadBoardPageWithAuthors(client, {
      id: continuationBoardId,
      cursor: target.searchParams.get('cursor')!,
      ...(sort === 'active' ? {} : { sort }),
    });
    const feed = await render(page, sort);
    expect(feed).toContain('data-slot="board-community"');
    expect(feed).toContain('data-slot="board-banner-fallback"');
    expect(feed).toContain('data-slot="avatar"');
    expect(feed).toContain('Flight notes Watch the baobabs');
    expect(feed).toContain('data-slot="feed-action-bar"');
    expect(feed).toContain(m.feed_action_reply());
    expect(feed).not.toContain(m.threads_next_page());
    expect(feed).not.toContain(m.realm_join());
    expect(calls.filter((url) => url.pathname === '/v1/accounts')).toHaveLength(1);
    expect(calls.filter((url) => url.pathname.endsWith('/threads')).map((url) => url.searchParams.get('sort'))).toEqual(
      [sort === 'new' ? null : sort, sort === 'new' ? null : sort],
    );
    expect(calls.some((url) => /^\/v1\/(threads|posts|media)\//u.test(url.pathname))).toBe(false);
    const sorts = [...feed.matchAll(/href="([^"]+)"/gu)]
      .map((match) => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://site.test'))
      .filter((url) => url.pathname.endsWith(continuationBoardId));
    expect(sorts.every((url) => !url.searchParams.has('cursor'))).toBe(true);
  }
});

test('removed openings and denied sources never become hidden previews, fabricated Global membership or an empty success', async () => {
  setLocale('en', { reload: false });
  const recorded = createStoryRecordedKernelFetch();
  const client = createKernelClient('https://kernel.test', { fetch: recorded });
  const page = await loadBoardPageWithAuthors(client, { id: continuationBoardId, cursor: continuationCursor });
  const original = page.threads.threads[0]!;
  const erased: typeof original = {
    ...original,
    title: null,
    firstPost: { ...original.firstPost, availability: 'erased', body: null, sha256: null, removed: true },
  };
  expect(boardThreadPreview(erased)).toBeNull();
  const removed = await render({ ...page, threads: { ...page.threads, threads: [erased] } });
  expect(removed).toContain(m.board_feed_opening_unavailable());
  expect(removed).not.toContain('Watch the baobabs');
  expect(removed).not.toContain('Letters from B-612');
  expect(removed).toContain('data-slot="board-feed-card"');
  const absentRealm = createKernelClient('https://kernel.test', {
    fetch: (input, init) =>
      new URL(new Request(input, init).url).pathname.startsWith('/v1/realms/')
        ? Promise.resolve(Response.json({ code: 'not_found' }, { status: 404 }))
        : recorded(input, init),
  });
  const realm = await loadBoardPageWithAuthors(absentRealm, { id: realmBoard.board.id });
  const unavailable = await render(realm);
  expect(unavailable).toContain(m.board_community_source_unavailable());
  expect(unavailable).not.toContain(m.board_community_global());
  expect(unavailable).not.toContain(m.realm_join());
  for (const resource of ['board', 'threads'])
    for (const status of [404, 503]) {
      const denied = createKernelClient('https://kernel.test', {
        fetch: (input, init) => {
          const url = new URL(new Request(input, init).url);
          const refuse =
            resource === 'threads' ? url.pathname.endsWith('/threads') : url.pathname.endsWith(continuationBoardId);
          return refuse
            ? Promise.resolve(
                Response.json({ code: status === 404 ? 'not_found' : 'dependency_unavailable' }, { status }),
              )
            : recorded(input, init);
        },
      });
      const attempt = loadBoardPageWithAuthors(denied, { id: continuationBoardId, cursor: continuationCursor });
      if (status === 404) await expect(attempt).rejects.toMatchObject({ isNotFound: true });
      else await expect(attempt).rejects.toThrow(/Kernel .* read failed/u);
    }
});
